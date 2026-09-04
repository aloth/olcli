/**
 * Interactive terminal prompts.
 *
 * Exists for one reason: reading a password without it appearing on the
 * command line, and therefore in shell history. See issue #50.
 *
 * No dependency for this. A masked read is a raw-mode loop over stdin, and
 * pulling in a prompt library to avoid writing it would cost more than it
 * saves - the bar in this repo is low dependency count, not zero.
 *
 * The keystroke handling is a pure reducer (`applyChunk`) with the terminal
 * wiring wrapped around it, for the same reason `diff.ts` is pure: a raw-mode
 * loop cannot be exercised without a pty, and the part that can silently
 * corrupt a password is the character handling, not the plumbing.
 */

import { stdin, stdout } from 'node:process';

const CTRL_C = '\u0003';
const CTRL_D = '\u0004';
const DEL = '\u007f';
const ESC = '\u001b';

/** Raised when the user aborts the prompt (Ctrl+C / Ctrl+D). */
export class PromptCancelled extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'PromptCancelled';
  }
}

/** Raised when there is no terminal to prompt on. */
export class NotATerminal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotATerminal';
  }
}

export interface KeyState {
  /** What the user has typed so far. */
  value: string;
  /**
   * Where we are in an ANSI escape sequence.
   *
   * 'none' - ordinary input
   * 'esc'  - saw ESC, waiting to see whether a sequence follows
   * 'csi'  - inside `ESC [` or `ESC O`, swallowing until the final byte
   */
  escape: 'none' | 'esc' | 'csi';
  outcome: 'pending' | 'submit' | 'cancel';
}

export function initialKeyState(): KeyState {
  return { value: '', escape: 'none', outcome: 'pending' };
}

/**
 * Fold one chunk of terminal input into the state.
 *
 * A chunk is not one keystroke: a paste arrives whole, and a single arrow key
 * arrives as the three characters `ESC [ A`. Both have to be handled here.
 *
 * Escape sequences are swallowed rather than filtered character by character.
 * Dropping only the ESC leaves `[` and `A` behind, and both are printable - so
 * an arrow key pressed mid-entry would append "[A" to the password and the
 * user would never see it. That is the failure this state machine exists to
 * prevent; it was found by driving the prompt over a pty.
 */
export function applyChunk(state: KeyState, chunk: string): KeyState {
  let { value, escape, outcome } = state;

  for (const ch of chunk) {
    if (outcome !== 'pending') break;

    if (escape === 'csi') {
      // Parameter and intermediate bytes continue the sequence; a final byte
      // in @..~ ends it. `ESC [ 3 ~` (Delete) needs the parameter handling.
      if (ch >= '@' && ch <= '~') escape = 'none';
      continue;
    }

    if (escape === 'esc') {
      // `ESC [` is CSI, `ESC O` is the alternate cursor mode some terminals
      // use for arrows. Anything else was a lone ESC plus a real character.
      escape = ch === '[' || ch === 'O' ? 'csi' : 'none';
      continue;
    }

    switch (ch) {
      case '\r':
      case '\n':
        outcome = 'submit';
        break;
      case CTRL_C:
      case CTRL_D:
        outcome = 'cancel';
        break;
      case DEL:
      case '\b':
        value = value.slice(0, -1);
        break;
      case ESC:
        escape = 'esc';
        break;
      default:
        // Remaining control characters are not password material. Appending
        // them would corrupt the value invisibly.
        if (ch >= ' ') value += ch;
    }
  }

  return { value, escape, outcome };
}

/**
 * Read a line from stdin without echoing it.
 *
 * Nothing is written back as the user types - not even asterisks. `sudo`
 * behaves the same way, and echoing one character per keystroke leaks the
 * length of the secret to anyone looking at the screen.
 *
 * Throws `NotATerminal` when stdin is piped or redirected. A masked read is
 * impossible there, and silently falling back to an unmasked one would defeat
 * the point; the caller is expected to name the scripted alternative instead.
 */
export function promptHidden(label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!stdin.isTTY) {
      reject(new NotATerminal('stdin is not a terminal, so a password cannot be prompted for'));
      return;
    }

    // Restore whatever mode the caller was in rather than assuming cooked:
    // olcli may be driven from a wrapper that set raw mode itself.
    const wasRaw = stdin.isRaw;
    let state = initialKeyState();
    let settled = false;

    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      stdin.removeListener('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      stdout.write('\n');
    };

    const onData = (chunk: string): void => {
      state = applyChunk(state, chunk);
      if (state.outcome === 'submit') {
        cleanup();
        resolve(state.value);
      } else if (state.outcome === 'cancel') {
        cleanup();
        reject(new PromptCancelled());
      }
    };

    // Raw mode goes on before the label is written. The terminal's line
    // discipline echoes whatever arrives while ECHO is still set, so a caller
    // that answers the instant the prompt appears - anything automated - would
    // otherwise have its first keystrokes echoed to the screen.
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', onData);

    stdout.write(label);
  });
}

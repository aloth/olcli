import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  promptHidden,
  applyChunk,
  initialKeyState,
  NotATerminal,
  PromptCancelled
} from '../src/prompt.js';

const CTRL_C = '\u0003';
const CTRL_D = '\u0004';
const DEL = '\u007f';
const ESC = '\u001b';

/** Feed chunks in order, as the terminal would deliver them. */
const type = (...chunks: string[]) =>
  chunks.reduce((state, chunk) => applyChunk(state, chunk), initialKeyState());

test('applyChunk: collects printable characters and submits on Enter', () => {
  const state = type('hunter2', '\r');
  assert.equal(state.value, 'hunter2');
  assert.equal(state.outcome, 'submit');
});

test('applyChunk: a paste arrives as one chunk and is kept whole', () => {
  assert.equal(type('a-long-pasted-secret', '\r').value, 'a-long-pasted-secret');
});

test('applyChunk: backspace and DEL remove the last character', () => {
  assert.equal(type('abcXX', DEL, DEL, '\r').value, 'abc');
  assert.equal(type('abcX', '\b', '\r').value, 'abc');
});

test('applyChunk: backspace on an empty value is a no-op, not an error', () => {
  assert.equal(type(DEL, DEL, 'a', '\r').value, 'a');
});

test('applyChunk: Ctrl+C and Ctrl+D cancel', () => {
  assert.equal(type('abc', CTRL_C).outcome, 'cancel');
  assert.equal(type('abc', CTRL_D).outcome, 'cancel');
});

test('applyChunk: an arrow key mid-entry contributes nothing', () => {
  // The regression this reducer exists for. Filtering only the ESC leaves the
  // printable '[' and 'A' behind, which silently appended "[A" to the
  // password. Found by driving the real prompt over a pty.
  assert.equal(type('pa', `${ESC}[A`, 'ss', '\r').value, 'pass');
});

test('applyChunk: multi-byte CSI sequences are swallowed whole', () => {
  // Delete is ESC [ 3 ~ - the parameter byte has to be consumed too, or the
  // '3' lands in the password.
  assert.equal(type('pa', `${ESC}[3~`, 'ss', '\r').value, 'pass');
  // Home in application cursor mode is ESC O H.
  assert.equal(type('pa', `${ESC}OH`, 'ss', '\r').value, 'pass');
});

test('applyChunk: an escape sequence split across chunks is still swallowed', () => {
  // A terminal is free to deliver ESC, '[' and 'A' in separate reads, which is
  // why the escape state lives in KeyState rather than in a local variable.
  assert.equal(type('pa', ESC, '[', 'A', 'ss', '\r').value, 'pass');
});

test('applyChunk: input after Enter is ignored', () => {
  const state = type('abc\rdef');
  assert.equal(state.value, 'abc');
  assert.equal(state.outcome, 'submit');
});

test('applyChunk: an empty password is a valid submit, distinct from a cancel', () => {
  // `auth` rejects the empty value with its own message; the reducer must not
  // conflate "typed nothing" with "pressed Ctrl+C".
  const state = type('\r');
  assert.equal(state.value, '');
  assert.equal(state.outcome, 'submit');
});

test('applyChunk: non-ASCII characters survive', () => {
  assert.equal(type('pásswörd✓', '\r').value, 'pásswörd✓');
});

// The masked read itself needs a real TTY and cannot be exercised here - the
// test runner's stdin is not one. That is precisely the branch worth pinning:
// `auth` relies on this rejection to tell a scripted caller to use
// OVERLEAF_EMAIL/OVERLEAF_PASSWORD rather than silently reading the password
// unmasked from a pipe.

test('promptHidden: rejects with NotATerminal when stdin is not a TTY', async () => {
  await assert.rejects(
    () => promptHidden('Password: '),
    (error: unknown) => {
      assert.ok(error instanceof NotATerminal, 'callers switch on the error type');
      return true;
    }
  );
});

test('promptHidden: does not write the label when it cannot prompt', async () => {
  // Writing a prompt and then failing would leave a stray "Password:" in the
  // output of a scripted run, ahead of the error explaining what to do.
  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;

  try {
    await promptHidden('Password: ').catch(() => { /* asserted above */ });
  } finally {
    process.stdout.write = original;
  }

  assert.deepEqual(written, []);
});

test('PromptCancelled and NotATerminal are distinguishable', () => {
  // `auth` maps one to "Cancelled." and the other to a message naming the
  // scripted alternative; collapsing them would give the wrong advice.
  assert.ok(!(new PromptCancelled() instanceof NotATerminal));
  assert.ok(!(new NotATerminal('x') instanceof PromptCancelled));
});

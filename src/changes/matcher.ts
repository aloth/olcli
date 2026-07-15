import { createHash } from 'node:crypto';

import { OlcliError } from '../errors/olcli-error.js';

export interface TextMatchInput {
  oldText: string;
  newText: string;
  occurrence?: number;
  position?: number;
  line?: number;
  column?: number;
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function lineColumnToPosition(content: string, line: number, column: number): number {
  const lines = content.split('\n');
  if (!Number.isSafeInteger(line) || line < 1 || line > lines.length) {
    throw new OlcliError('SOURCE_MISMATCH', `Line out of range: ${line}`);
  }
  const selectedLine = lines[line - 1];
  if (!Number.isSafeInteger(column) || column < 1 || column > selectedLine.length + 1) {
    throw new OlcliError('SOURCE_MISMATCH', `Column out of range: ${column}`);
  }
  return lines.slice(0, line - 1).reduce((sum, value) => sum + value.length + 1, 0)
    + column - 1;
}

function explicitPosition(content: string, input: TextMatchInput): number | undefined {
  if (input.position !== undefined && (input.line !== undefined || input.column !== undefined)) {
    throw new OlcliError('SOURCE_MISMATCH', 'Use either position or line/column, not both.');
  }
  if ((input.line === undefined) !== (input.column === undefined)) {
    throw new OlcliError('SOURCE_MISMATCH', 'Line and column must be provided together.');
  }
  if (input.position !== undefined) {
    if (!Number.isSafeInteger(input.position) || input.position < 0 || input.position > content.length) {
      throw new OlcliError('SOURCE_MISMATCH', `Position out of range: ${input.position}`);
    }
    return input.position;
  }
  if (input.line !== undefined && input.column !== undefined) {
    return lineColumnToPosition(content, input.line, input.column);
  }
  return undefined;
}

export function resolveTextMatchPosition(content: string, input: TextMatchInput): number {
  if (input.oldText === input.newText) {
    throw new OlcliError('SOURCE_MISMATCH', 'The old and new text are identical; no suggestion is needed.');
  }

  const position = explicitPosition(content, input);
  if (position !== undefined) {
    if (input.oldText.length > 0 && content.slice(position, position + input.oldText.length) !== input.oldText) {
      throw new OlcliError('SOURCE_MISMATCH', 'Source text does not match at the requested position.', {
        details: { position, expectedLength: input.oldText.length },
      });
    }
    return position;
  }

  if (input.oldText.length === 0) {
    throw new OlcliError(
      'SOURCE_TEXT_NOT_FOUND',
      'An insertion with empty old text requires --position or --line/--column.'
    );
  }
  if (input.occurrence !== undefined && (!Number.isSafeInteger(input.occurrence) || input.occurrence < 1)) {
    throw new OlcliError('SOURCE_MISMATCH', 'Occurrence must be a positive one-based integer.');
  }

  const matches: number[] = [];
  let cursor = 0;
  while (cursor <= content.length - input.oldText.length) {
    const match = content.indexOf(input.oldText, cursor);
    if (match < 0) break;
    matches.push(match);
    cursor = match + 1;
  }

  if (matches.length === 0) {
    throw new OlcliError('SOURCE_TEXT_NOT_FOUND', 'The requested source text was not found.');
  }
  if (input.occurrence !== undefined) {
    const selected = matches[input.occurrence - 1];
    if (selected === undefined) {
      throw new OlcliError('SOURCE_TEXT_NOT_FOUND', 'The requested occurrence does not exist.', {
        details: { occurrence: input.occurrence, matchCount: matches.length },
      });
    }
    return selected;
  }
  if (matches.length > 1) {
    throw new OlcliError('AMBIGUOUS_MATCH', 'The source text occurs more than once; specify --occurrence.', {
      details: { matchCount: matches.length },
    });
  }
  return matches[0];
}

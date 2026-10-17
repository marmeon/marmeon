import { describe, expect, it } from 'vitest';
import { parseOxlint, plainReason } from './tools.ts';

describe('parseOxlint', () => {
  // The shape `oxlint --format=json` prints (checked against the oxlint in this repository by check.test.ts).
  const document = JSON.stringify({
    diagnostics: [
      { message: '`debugger` statement is not allowed', code: 'eslint(no-debugger)', severity: 'error', help: 'Remove the debugger statement', filename: '/app/src/a.ts', labels: [{ span: { offset: 0, length: 9, line: 4, column: 3 } }] },
      { message: 'Unused', code: 'eslint(no-unused-vars)', severity: 'warning', filename: 'src/b.ts', labels: [] },
    ],
    number_of_files: 2,
  });

  it('maps severity, place and rule, with paths relative to the root', () => {
    expect(parseOxlint(document, '/app')).toEqual([
      { severity: 'error', message: '`debugger` statement is not allowed — Remove the debugger statement', file: 'src/a.ts', line: 4, column: 3, rule: 'eslint(no-debugger)' },
      { severity: 'warning', message: 'Unused', file: 'src/b.ts', rule: 'eslint(no-unused-vars)' },
    ]);
  });

  it('returns undefined for anything that is not the document', () => {
    expect(parseOxlint('not json', '/app')).toBeUndefined();
    expect(parseOxlint('{"other":1}', '/app')).toBeUndefined();
    expect(parseOxlint('null', '/app')).toBeUndefined();
  });
});

describe('plainReason', () => {
  it('writes the app directory as a dot', () => {
    expect(plainReason(new Error('ENOENT: no such file /srv/app/src/a.ts and /srv/app'), '/srv/app')).toBe('ENOENT: no such file ./src/a.ts and .');
  });
});

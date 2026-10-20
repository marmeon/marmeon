import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../../scripts/test/temp-dir.js';
import type { CheckProblem } from './report.ts';
import { silence } from './silence.ts';

function app(files: Record<string, string>): string {
  const root = tempDir('marmeon-check-silence-');
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

const finding = (line: number, file = 'src/a.ts'): CheckProblem => ({ severity: 'warning', message: 'raw', file, line, column: 1, rule: 'marmeon(raw-sql)' });

describe('silence', () => {
  it('silences a finding on the line below the comment and on the line the comment ends on', () => {
    const root = app({ 'src/a.ts': ['// marmeon-check-ignore raw-sql: from a list', 'one();', 'two(); // marmeon-check-ignore raw-sql: fixed', ''].join('\n') });
    const result = silence('raw-sql', root, [finding(2), finding(3)]);
    expect(result.problems).toEqual([]);
    expect(result.silenced).toMatchObject([
      { line: 2, reason: 'from a list' },
      { line: 3, reason: 'fixed' },
    ]);
  });

  it('takes the end of a block comment, in JSX too', () => {
    const root = app({ 'src/a.tsx': ['/* marmeon-check-ignore raw-sql: a', ' * reason', ' */', 'one();', '{/* marmeon-check-ignore raw-sql: jsx */}', 'two();', ''].join('\n') });
    const result = silence('raw-sql', root, [finding(4, 'src/a.tsx'), finding(6, 'src/a.tsx')]);
    expect(result.problems).toEqual([]);
    expect(result.silenced.map((problem) => problem.reason)).toEqual(['a reason', 'jsx']);
  });

  it('lets a comment at the end of a line reach that line only', () => {
    const root = app({ 'src/a.ts': ['one(); // marmeon-check-ignore raw-sql: this call', 'two();', ''].join('\n') });
    const result = silence('raw-sql', root, [finding(1), finding(2)]);
    expect(result.silenced.map((problem) => problem.line)).toEqual([1]);
    expect(result.problems).toMatchObject([{ line: 2, rule: 'marmeon(raw-sql)' }]);
  });

  it('names the check that finds nothing when a comment names several', () => {
    const root = app({ 'src/a.ts': '// marmeon-check-ignore inner-html, raw-sql: both\nconst a = 1;\n' });
    expect(silence('raw-sql', root, []).problems).toMatchObject([{ message: '`raw-sql` finds nothing on this line or the next — remove it from this comment' }]);
  });

  it('does not reach two lines down or into another file', () => {
    const root = app({ 'src/a.ts': '// marmeon-check-ignore raw-sql: why\n\none();\n', 'src/b.ts': 'two();\n' });
    const result = silence('raw-sql', root, [finding(3), finding(1, 'src/b.ts')]);
    expect(result.silenced).toEqual([]);
    expect(result.problems.filter((problem) => problem.rule === 'marmeon(raw-sql)')).toHaveLength(2);
    expect(result.problems).toContainEqual(expect.objectContaining({ severity: 'warning', file: 'src/a.ts', line: 1, rule: 'marmeon(check-ignore)', message: expect.stringContaining('silences nothing') }));
  });

  it('keeps a finding whose comment has no reason, and warns about the comment', () => {
    for (const comment of ['// marmeon-check-ignore raw-sql', '// marmeon-check-ignore raw-sql:', '// marmeon-check-ignore raw-sql:   ']) {
      const result = silence('raw-sql', app({ 'src/a.ts': `${comment}\none();\n` }), [finding(2)]);
      expect(result.silenced).toEqual([]);
      expect(result.problems).toMatchObject([{ rule: 'marmeon(raw-sql)' }, { severity: 'warning', file: 'src/a.ts', line: 1, rule: 'marmeon(check-ignore)', message: expect.stringContaining('needs a reason') }]);
    }
  });

  it('warns about a comment that covers no finding', () => {
    const result = silence('raw-sql', app({ 'src/a.ts': '// marmeon-check-ignore raw-sql: why\nconst a = 1;\n' }), []);
    expect(result.problems).toMatchObject([{ severity: 'warning', file: 'src/a.ts', line: 1, rule: 'marmeon(check-ignore)', message: expect.stringContaining('silences nothing — remove it') }]);
  });

  it('reads a list of names and ignores the other checks and the names nobody knows', () => {
    const root = app({
      'src/a.ts': '// marmeon-check-ignore inner-html, raw-sql: both\none();\n',
      'src/b.ts': '// marmeon-check-ignore inner-html: not this check\ntwo();\n',
      'src/c.ts': '// marmeon-check-ignore nothing-like-it: why\nthree();\n',
    });
    const result = silence('raw-sql', root, [finding(2), finding(2, 'src/b.ts'), finding(2, 'src/c.ts')]);
    expect(result.silenced.map((problem) => problem.file)).toEqual(['src/a.ts']);
    expect(result.problems).toHaveLength(2);
    expect(result.problems.every((problem) => problem.rule === 'marmeon(raw-sql)')).toBe(true);
  });

  it('is not silenced by the text of a string or a template', () => {
    const root = app({ 'src/a.ts': "const a = '// marmeon-check-ignore raw-sql: why';\nconst b = `/* marmeon-check-ignore raw-sql: why */`; one();\n" });
    const result = silence('raw-sql', root, [finding(1), finding(2)]);
    expect(result.silenced).toEqual([]);
    expect(result.problems).toHaveLength(2);
  });

  it('shortens a long reason to 200 characters and writes control characters out', () => {
    const root = app({ 'src/a.ts': `/* marmeon-check-ignore raw-sql: ${'x'.repeat(300)}\u001b[31m */\none();\n` });
    expect(silence('raw-sql', root, [finding(2)]).silenced[0]!.reason).toBe('x'.repeat(200));
    const escape = app({ 'src/a.ts': '// marmeon-check-ignore raw-sql: red \u001b[31m\none();\n' });
    expect(silence('raw-sql', escape, [finding(2)]).silenced[0]!.reason).toBe('red \\x1b[31m');
  });

  it('does not read test files or files that do not parse', () => {
    const root = app({ 'src/a.test.ts': '// marmeon-check-ignore raw-sql: why\none();\n', 'src/broken.ts': '// marmeon-check-ignore raw-sql: why\none(\n' });
    expect(silence('raw-sql', root, [finding(2), finding(2, 'src/broken.ts')]).silenced).toEqual([]);
  });
});

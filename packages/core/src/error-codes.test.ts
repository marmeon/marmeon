import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { errorCodeOf, withCode } from './error-codes.ts';

describe('error codes', () => {
  it('withCode puts the code in square brackets before the message', () => {
    expect(withCode('K6', 'Invalid configuration')).toBe('[marmeon:K6] Invalid configuration');
  });

  it('errorCodeOf reads the code from the message, then from the causes down to five deep', () => {
    expect(errorCodeOf(new Error(withCode('D1', 'x')))).toBe('D1');
    expect(errorCodeOf(new Error('outer', { cause: new Error(withCode('Q4', 'x')) }))).toBe('Q4');
    let chain: Error = new Error(withCode('K1', 'deep'));
    for (let i = 0; i < 4; i++) chain = new Error('wrapper', { cause: chain });
    expect(errorCodeOf(chain)).toBe('K1'); // five levels
    expect(errorCodeOf(new Error('wrapper', { cause: chain }))).toBeUndefined(); // six
  });

  it('finds nothing in a non-error, a prefix inside the text or an unknown letter', () => {
    expect(errorCodeOf('[marmeon:K1] text')).toBeUndefined();
    expect(errorCodeOf(new Error('see [marmeon:K1] here'))).toBeUndefined();
    expect(errorCodeOf(new Error('[marmeon:Z1] unknown'))).toBeUndefined();
    expect(errorCodeOf(new Error('[marmeon:K1]no space'))).toBeUndefined();
  });

  it('knows the browser codes too', () => {
    expect(errorCodeOf(new Error('[marmeon:C1] x'))).toBe('C1');
  });
});

const PACKAGES = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/** The problems between the codes the sources use and the rows of the table: a code without a row, a row twice, a row without a link, a row unused. */
export function compareCodes(used: readonly string[], rows: readonly { code: string; line: string }[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const { code, line } of rows) {
    if (seen.has(code)) problems.push(`${code} is listed twice`);
    seen.add(code);
    if (!/\]\([^)]*\.md#[^)]+\)/.test(line)) problems.push(`${code} has no link to the docs`);
    if (!used.includes(code) && !/retired/.test(line)) problems.push(`${code} is listed but never used`);
  }
  for (const code of new Set(used)) if (!seen.has(code)) problems.push(`${code} is used but has no row`);
  return problems;
}

/** The source without its comments, so that a code named in a JSDoc is no use. */
export function withoutComments(text: string): string {
  // Only comments that start a line (or follow whitespace and `// `) — a `/*` inside a glob string is no comment.
  return text.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '').replace(/^[ \t]*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
}

/** The `withCode(` calls that do not name a literal code as their first argument. */
export function malformedCalls(text: string): string[] {
  return [...text.matchAll(/\bwithCode\((?!\s*'[KHDAQS]\d+')(?:(?!\bwithCode\()[^\n])*/g)].map((match) => match[0]);
}

describe('the register of server error codes', () => {
  const sources = readdirSync(PACKAGES, { recursive: true, encoding: 'utf8' })
    .filter((file) => /^[^/]+\/src\/.*\.tsx?$/.test(file) && !/node_modules|\.test\.tsx?$|\.type-test\.ts$|__fixtures__|test-helpers|\/client\//.test(file))
    .map((file) => ({ file, text: withoutComments(readFileSync(join(PACKAGES, file), 'utf8')) }));
  const used = sources.flatMap(({ text }) =>
    [...text.matchAll(/withCode\(\s*'([KHDAQS]\d+)'|\[marmeon:([KHDAQS]\d+)\]/g)].map((match) => match[1] ?? match[2]!),
  );
  const docs = readFileSync(join(PACKAGES, '..', 'docs', 'errors.md'), 'utf8');
  const section = docs.split('### Server error codes')[1]!.split(/\n#{2,3} /)[0]!;
  const rows = [...section.matchAll(/^\| ([KHDAQS]\d+) \|.*$/gm)].map((match) => ({ code: match[1]!, line: match[0] }));

  it('lists every code the sources use once, with a link, and nothing else', () => {
    expect(compareCodes(used, rows)).toEqual([]);
  });

  it('every withCode call names its code as a literal', () => {
    const offenders = sources.filter(({ file }) => !file.endsWith('core/src/error-codes.ts')).flatMap(({ file, text }) => malformedCalls(text).map((call) => `${file}: ${call}`));
    expect(offenders).toEqual([]);
  });

  it('reports a code without a row, a row twice, a row without a link and a row nobody uses', () => {
    expect(compareCodes(['K1', 'K9'], [{ code: 'K1', line: '| K1 | core | a. [x](a.md#b) |' }])).toEqual(['K9 is used but has no row']);
    const twice = { code: 'K1', line: '| K1 | core | a. [x](a.md#b) |' };
    expect(compareCodes(['K1'], [twice, twice])).toEqual(['K1 is listed twice']);
    expect(compareCodes(['K1'], [{ code: 'K1', line: '| K1 | core | a |' }])).toEqual(['K1 has no link to the docs']);
    expect(compareCodes([], [{ code: 'K1', line: '| K1 | core | a. [x](a.md#b) |' }])).toEqual(['K1 is listed but never used']);
    expect(compareCodes([], [{ code: 'K1', line: '| K1 | core | retired. [x](a.md#b) |' }])).toEqual([]);
  });

  it('keeps code after a glob string and a URL, and drops a trailing comment', () => {
    const globs = "const g = ['modules/*/views/**', 'a/*'];\nwithCode('K1', 'x');\nconst h = ['**/controllers/**/*.ts'];";
    expect(withoutComments(globs)).toContain("withCode('K1'");
    expect(withoutComments("const u = 'https://example.com/a'; const w = 1; // withCode('K2', y)")).toContain('https://example.com/a');
    expect(withoutComments("const w = 1; // withCode('K2', y)")).not.toContain('K2');
  });

  it('does not count a code named in a comment, and finds a withCode call with a computed code', () => {
    expect(withoutComments("/** `[marmeon:K6] x` */\n// withCode('K7', y)\nconst a = 1;")).not.toMatch(/K6|K7/);
    expect(malformedCalls("withCode(`K${n}`, 'x'); withCode(code, 'x'); withCode(\"K1\", 'x'); withCode('K1', 'x')")).toHaveLength(3);
  });
});

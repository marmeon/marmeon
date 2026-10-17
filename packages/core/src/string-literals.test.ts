import { describe, expect, it } from 'vitest';
import { stringLiterals } from './string-literals.ts';

describe('stringLiterals', () => {
  it('finds import sources, import(), require, re-exports and type positions with 1-based line and column', () => {
    const source = [
      "import { a } from 'one';",
      "export * from 'two';",
      "  const b = await import('three');",
      "const c = require(\"four\");",
      "type D = typeof import('five');",
      "const e: 'six' = 'six';",
    ].join('\n');
    const found = stringLiterals(source, 'x.ts')!;
    expect(found.map((literal) => literal.value)).toEqual(['one', 'two', 'three', 'four', 'five', 'six', 'six']);
    expect(found[0]).toEqual({ value: 'one', line: 1, column: 19 });
    expect(found[2]).toEqual({ value: 'three', line: 3, column: 26 });
  });

  it('reads a template without an expression, not one with', () => {
    const found = stringLiterals('const a = `plain`;\nconst b = `x${1}y`;', 'x.ts')!;
    expect(found).toEqual([{ value: 'plain', line: 1, column: 11 }]);
  });

  it('reads a triple-slash reference whatever the order of its attributes', () => {
    const source = '/// <reference resolution-mode="import" types="@marmeon/core/internal" />\nexport {};';
    expect(stringLiterals(source, 'x.ts')?.map((literal) => literal.value)).toEqual(['@marmeon/core/internal']);
  });

  it('ignores comments except a triple-slash reference, and yields undefined for a file that does not parse', () => {
    expect(stringLiterals("// 'in a comment'\n/* \"also\" */", 'x.ts')).toEqual([]);
    expect(stringLiterals('/// <reference types="@marmeon/core/internal" />\nexport {};', 'x.ts')).toEqual([{ value: '@marmeon/core/internal', line: 1, column: 23 }]);
    expect(stringLiterals("const = 'x'", 'x.ts')).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { deprecationProblems, findDeprecations, removalIsAfter } from './deprecations.ts';
import type { SourceFile } from './source-files.ts';

const problems = (text: string, path = 'packages/http/src/x.ts', files: SourceFile[] = []) =>
  deprecationProblems(findDeprecations([{ path, text }, ...files]), '0.3.0');
const tag = (body: string) => `/** @deprecated ${body} */\nexport const x = 1;`;
const call = (...args: string[]) => `import { deprecated } from '@marmeon/core/deprecation';\nexport function f() {\n  deprecated(${args.join(', ')});\n}`;

describe('deprecation tags', () => {
  it('accepts a replacement, a docs link and a removal version', () => {
    expect(problems(tag('Use {@link y} instead. Removed in 0.5; docs/forms.md#remembering-input.'))).toEqual([]);
    expect(problems(tag('Use `y`. Removed in 1.0; docs/forms.md#remembering-input.'))).toEqual([]);
  });

  it('accepts the form package development shows', () => {
    expect(problems(tag('Use {@link Greeter.greet} instead. Removed in 2.0; docs/greeter.md#greeting.'))).toEqual([]);
  });

  it('accepts a tag over several lines and one followed by another tag', () => {
    const text = '/**\n * Whether x.\n *\n * @deprecated Use {@link y}\n * instead. Removed in 0.5;\n * docs/forms.md#remembering-input.\n * @param a - a\n */\nexport function x() {}';
    expect(problems(text)).toEqual([]);
  });

  it('names a tag without a replacement, a link or a version, with path and line', () => {
    expect(problems(tag('Removed in 0.5; docs/forms.md#remembering-input.'))).toEqual([expect.stringContaining('packages/http/src/x.ts:1:')]);
    expect(problems(tag('Removed in 0.5; docs/forms.md#remembering-input.'))[0]).toContain('replacement');
    expect(problems(tag('Use {@link y}. Removed in 0.5.'))[0]).toContain('link the docs');
    expect(problems(tag('Use {@link y}; docs/forms.md#remembering-input.'))[0]).toContain('Removed in');
    expect(problems(tag('Use {@link y}. Removed in 0.5; docs/forms.md.'))).toHaveLength(1);
    expect(problems(`\n\n${tag('x')}`)[0]).toContain('x.ts:3:');
  });

  it('finds a tag however it is written: indented, mid-line, after another tag, at the start of a line', () => {
    for (const comment of ['/**\n *   @deprecated\n */', '/** Old thing. @deprecated */', '/** @internal @deprecated */', '/**\n * @see x\n * @deprecated\n */']) {
      expect(problems(`${comment}\nexport const x = 1;`), comment).toEqual([expect.stringContaining('replacement')]);
    }
    expect(problems('/** @internal @deprecated Use {@link y}. Removed in 9.0; docs/forms.md#remembering-input. */\nexport const x = 1;')).toEqual([]);
  });

  it('does not take a mention for a tag', () => {
    expect(problems('/** The `@deprecated` tag, or {@deprecated} inline. */\nexport const x = 1;')).toEqual([]);
  });

  it('does not take a later tag for part of the text', () => {
    const text = '/**\n * @deprecated Use {@link y}. Removed in 0.5.\n * @see docs/forms.md#remembering-input\n */\nexport const x = 1;';
    expect(problems(text)).toHaveLength(1);
  });

  it('ignores tests, type tests and fixtures, and files outside a package', () => {
    expect(problems(tag('x'), 'packages/http/src/x.test.ts')).toEqual([]);
    expect(problems(tag('x'), 'packages/http/src/x.type-test.ts')).toEqual([]);
    expect(problems(tag('x'), 'packages/http/src/__fixtures__/x.ts')).toEqual([]);
    expect(problems(tag('x'), 'apps/web-app/modules/x.ts')).toEqual([]);
  });

  it('refuses a version that is not after the current one', () => {
    expect(problems(tag('Use {@link y}. Removed in 0.3; docs/forms.md#remembering-input.'))[0]).toContain('not after the current version');
    expect(problems(tag('Use {@link y}. Removed in 0.4; docs/forms.md#remembering-input.'))).toEqual([]);
  });
});

describe('deprecated() calls', () => {
  it('accepts three literals', () => {
    expect(problems(call("'http.x'", "'Use y.'", "'2.0'"))).toEqual([]);
    expect(problems(call("'http.x'", '`Use y.`', "'2.0'"))).toEqual([]);
  });

  it('names an argument that is not a literal', () => {
    expect(problems(call('id', "'Use y.'", "'2.0'"))[0]).toContain('string literals');
    expect(problems(call("'http.x'", '`Use ${name}.`', "'2.0'"))[0]).toContain('string literals');
    expect(problems(call("'http.x'", "'Use y.'", 'VERSION'))[0]).toContain('string literals');
    expect(problems(call("'http.x'", "'Use y.'"))[0]).toContain('string literals');
  });

  it('names an id without a dot or with the segment of another package', () => {
    expect(problems(call("'x'", "'Use y.'", "'2.0'"))[0]).toContain('<package>.<name>');
    expect(problems(call("'Http.x'", "'Use y.'", "'2.0'"))[0]).toContain('<package>.<name>');
    expect(problems(call("'react.x'", "'Use y.'", "'2.0'"))[0]).toContain('package of the file (http)');
  });

  it('names an id used twice, in one file or two', () => {
    const twice = `${call("'http.x'", "'Use y.'", "'2.0'")}\nexport function g() {\n  deprecated('http.x', 'Use y.', '2.0');\n}`;
    expect(problems(twice)).toEqual([expect.stringContaining('taken already')]);
    expect(problems(call("'http.x'", "'Use y.'", "'2.0'"), 'packages/http/src/a.ts', [{ path: 'packages/http/src/b.ts', text: call("'http.x'", "'Use y.'", "'2.0'") }])).toHaveLength(1);
  });

  it('names a removal version that is not major.minor or not after the current one', () => {
    expect(problems(call("'http.x'", "'Use y.'", "'2'"))[0]).toContain('"major.minor"');
    expect(problems(call("'http.x'", "'Use y.'", "'v2.0'"))[0]).toContain('"major.minor"');
    expect(problems(call("'http.x'", "'Use y.'", "'0.3'"))[0]).toContain('not after the current version');
    expect(problems(call("'http.x'", "'Use y.'", "'0.2'"))).toHaveLength(1);
  });

  it('finds a call however it is written', () => {
    const body = "'Use y.', '0.1'";
    const bad = (text: string) => problems(text);
    expect(bad(`deprecated ('http.x', ${body});`)).toHaveLength(1);
    expect(bad(`deprecated?.('http.x', ${body});`)).toHaveLength(1);
    expect(bad(`import { deprecated as warn } from '@marmeon/core';\nwarn('http.x', m, '9.0');`)).toEqual([expect.stringContaining('string literals')]);
    expect(bad(`import { deprecated as warn } from './deprecation.ts';\nwarn('http.x', 'Use y.', '0.1');`)).toEqual([expect.stringContaining('not after')]);
    expect(bad(`import * as core from '@marmeon/core/deprecation';\ncore.deprecated('http.x', ${body});`)).toHaveLength(2);
    expect(bad(`ns.deprecated('http.x', ${body});`)).toHaveLength(1);
    expect(bad(`ns['deprecated']('http.x', ${body});`)).toHaveLength(1);
  });

  it('asks for a named import when a namespace hides the calls', () => {
    expect(problems("import * as d from './deprecation.ts';\nexport const a = 1;")).toEqual([expect.stringContaining('import deprecated by name')]);
    expect(problems("import * as core from '@marmeon/core';\nexport const a = 1;")).toEqual([]);
  });

  it('does not take the definition of deprecated() for a call', () => {
    expect(problems("export function deprecated(id: string): void {}\nexport const a = 1;", 'packages/core/src/deprecation.ts')).toEqual([]);
  });
});

describe('removalIsAfter', () => {
  it('compares major and minor, and a pre-release counts as its release', () => {
    expect(removalIsAfter('0.5', '0.4.2')).toBe(true);
    expect(removalIsAfter('1.0', '0.9.9')).toBe(true);
    expect(removalIsAfter('0.4', '0.4.0')).toBe(false);
    expect(removalIsAfter('0.4', '0.4.0-rc.1')).toBe(false);
    expect(removalIsAfter('0.4', '0.4.7')).toBe(false);
    expect(removalIsAfter('0.3', '0.4.0')).toBe(false);
  });
});

describe('from 1.0 on', () => {
  const at = (version: string, text: string) => deprecationProblems(findDeprecations([{ path: 'packages/http/src/x.ts', text }]), version);
  const removedIn = (version: string) => tag(`Use {@link y}. Removed in ${version}; docs/forms.md#remembering-input.`);

  it('keeps x.y before 1.0', () => {
    expect(at('0.9.0', removedIn('0.10'))).toEqual([]);
  });

  it('wants a major version in "Removed in"', () => {
    expect(at('1.0.0', removedIn('1.2'))[0]).toContain('Removed in 2.0');
    expect(at('1.0.0', removedIn('2.0'))).toEqual([]);
    expect(at('1.4.2', removedIn('2.0'))).toEqual([]);
    expect(at('1.4.2', removedIn('1.5'))).toHaveLength(1);
    expect(at('1.0.0-rc.1', removedIn('1.1'))).toHaveLength(1);
    expect(at('1.0.0-rc.1', removedIn('2.0'))).toEqual([]);
  });

  it('refuses a major that is not in the future, with one problem', () => {
    expect(at('1.0.0', removedIn('1.0'))).toEqual([expect.stringContaining('not after the current version')]);
    expect(at('1.4.2', removedIn('1.2'))[0]).not.toContain('major release');
    expect(at('1.4.2', removedIn('1.2'))[0]).toContain('not after the current version');
    expect(at('2.1.0', removedIn('2.0'))).toHaveLength(1);
    expect(at('2.1.0', removedIn('3.0'))).toEqual([]);
  });

  it('holds deprecated() calls to it as well', () => {
    expect(at('1.0.0', call("'http.x'", "'Use y.'", "'1.2'"))[0]).toContain('Removed in 2.0');
    expect(at('1.0.0', call("'http.x'", "'Use y.'", "'2.0'"))).toEqual([]);
  });
});

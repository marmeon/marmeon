import { describe, expect, it } from 'vitest';
import { staticNames } from './static-names.ts';

describe('staticNames', () => {
  it('reads string and plain template literals', () => {
    const source = ['export class A {', "  static job = 'billing.a';", '}', 'export class B {', '  static job = `billing.b`;', '}'].join('\n');
    expect(staticNames(source, 'x.ts', ['job'])).toEqual([
      { className: 'A', key: 'job', value: 'billing.a', line: 2 },
      { className: 'B', key: 'job', value: 'billing.b', line: 5 },
    ]);
  });

  it('reads `as const` and finds several classes of a file by their own keys', () => {
    const source = "class A { static job = 'a' as const }\nclass B { static notification = 'b' }\nclass C { static other = 'c' }";
    expect(staticNames(source, 'x.ts', ['job', 'notification']).map((n) => [n.className, n.key, n.value])).toEqual([
      ['A', 'job', 'a'],
      ['B', 'notification', 'b'],
    ]);
  });

  it('ignores computed keys, non-literals and template substitutions', () => {
    const source = ["const KEY = 'job', NAME = 'x';", 'class A { static [KEY] = "a" }', 'class B { static job = NAME }', 'class C { static job = `x${NAME}` }', 'class D { job = "instance" }'].join('\n');
    expect(staticNames(source, 'x.ts', ['job'])).toEqual([]);
  });

  it('yields nothing for a file that does not parse', () => {
    expect(staticNames("class A { static job = 'a' ", 'x.ts', ['job'])).toEqual([]);
  });
});

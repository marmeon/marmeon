import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzeInjections, injectConstructorDependencies } from './analyze.ts';
import { embedInjections } from './embed.ts';

const inject = (source: string) => injectConstructorDependencies(source, 'app/Example.ts');

/** The reason attached to the (single) class in `source` that cannot be injected. */
const failure = (source: string) => {
  const [site] = analyzeInjections(source, 'app/Example.ts');
  if (!site || !('unresolvable' in site)) throw new Error('expected an unresolvable class');
  return site.unresolvable;
};

describe('injectConstructorDependencies', () => {
  it('derives the list from classes and same-named tokens, on the class line', () => {
    const source = [
      "import { UserRepository } from './UserRepository.ts';",
      "import { Mailer } from '#modules/mail';",
      '',
      'export class ShowUserProfileController {',
      '  constructor(users: UserRepository, mailer: Mailer) {}',
      '}',
    ].join('\n');

    const output = inject(source);
    expect(output.split('\n')[3]).toBe('export class ShowUserProfileController { static inject = [UserRepository, Mailer];');
    expect(output.split('\n')).toHaveLength(source.split('\n').length);
  });

  it('covers default exports, class expressions and namespace imports', () => {
    const output = inject(
      [
        "import * as mail from './mail.ts';",
        "import { Clock } from './clock.ts';",
        'export default class { constructor(m: mail.Mailer) {} }',
        'export const Job = class { constructor(clock: Clock) {} };',
      ].join('\n'),
    );
    expect(output).toContain('export default class { static inject = [mail.Mailer];');
    expect(output).toContain('export const Job = class { static inject = [Clock];');
  });

  it('covers classes at any depth — factories, tests — resolving types against the module', () => {
    const output = inject(
      [
        "import { RateLimiter } from './limiter.ts';",
        'export function throttle(name: string) {',
        '  return class { constructor(limiter: RateLimiter) {} };',
        '}',
        'describe("x", () => {',
        '  class Local { constructor(limiter: RateLimiter) {} }',
        '  class NeedsLocal { constructor(local: Local) {} }',
        '});',
      ].join('\n'),
    );
    expect(output).toContain('  return class { static inject = [RateLimiter]; constructor');
    expect(output).toContain('  class Local { static inject = [RateLimiter]; constructor');
    // A type declared inside the function is not visible to the module: a reason, not a silent gap.
    expect(output).toMatch(/class NeedsLocal \{ static \[Symbol\.for\("bespokecore\.injection\.unresolvable"\)\] = ".*Local/);
  });

  it('erases type arguments', () => {
    const output = inject("import { Repository } from './x.ts';\nclass A { constructor(r: Repository<User>) {} }");
    expect(output).toContain('static inject = [Repository];');
  });

  it('stops at the first optional or defaulted parameter, so JavaScript defaults apply', () => {
    const source = "import { A, B } from './x.ts';\nclass C { constructor(a: A, b?: B, name = 'x') {} }";
    expect(inject(source)).toContain('class C { static inject = [A]; constructor');
    expect(inject('class Container { constructor(parent?: Container) {} }')).toBe(
      'class Container { constructor(parent?: Container) {} }',
    );
  });

  it('never throws for classes it cannot inject — it attaches the reason instead', () => {
    const output = inject('export class Money { constructor(amount: number) {} }');
    expect(output).toContain(
      'export class Money { static [Symbol.for("bespokecore.injection.unresolvable")] = "Cannot inject app/Example.ts:1 — Money',
    );
  });

  it('leaves classes alone that need nothing or declare their own list', () => {
    const untouched = [
      'class A {}',
      'class B { constructor() {} }',
      "import { C } from './c.ts';\nclass D { static inject = [C]; constructor(c: C) {} }",
    ];
    for (const source of untouched) expect(inject(source)).toBe(source);
  });

  it('inserts at the right offset after non-ASCII text', () => {
    const output = inject("// Grüße 🚀\nimport { Clock } from './c.ts';\nclass Ä { constructor(c: Clock) {} }");
    expect(output).toContain('class Ä { static inject = [Clock]; constructor');
  });

  it('explains interfaces imported with import type', () => {
    expect(failure("import type { Mailer } from './m.ts';\nclass A { constructor(m: Mailer) {} }")).toMatch(
      /Example\.ts:2 — A, parameter "m: Mailer": "Mailer" is imported with "import type".*import \{ Mailer \}/,
    );
  });

  it('explains local interfaces without a token', () => {
    expect(failure('interface Clock { now(): string }\nclass A { constructor(c: Clock) {} }')).toMatch(
      /"Clock" is only a type\. Declare a token next to it: export const Clock = token<Clock>\('Clock'\);/,
    );
  });

  it('rejects primitives, unions, missing annotations and rest parameters', () => {
    expect(failure('class A { constructor(name: string) {} }')).toMatch(/not "string"/);
    expect(failure("import { B, C } from './x.ts';\nclass A { constructor(x: B | C) {} }")).toMatch(/not "B \| C"/);
    expect(failure('class A { constructor(x) {} }')).toMatch(/add a type annotation/);
    expect(failure("import { B } from './x.ts';\nclass A { constructor(...xs: B[]) {} }")).toMatch(/rest parameters/);
    expect(failure('class A { constructor(x: Unknown) {} }')).toMatch(/"Unknown" is not imported or declared/);
  });

  it('reports every site in a module', () => {
    const sites = analyzeInjections("import { X } from './x.ts';\nclass A { constructor(x: X) {} }\nclass B { constructor(x: X) {} }", 'm.ts');
    expect(sites.map((site) => site.className)).toEqual(['A', 'B']);
  });
});

describe('embedInjections (bespoke package:build)', () => {
  const ts = [
    "import { Clock } from '@acme/clock';",
    "import { Formatter } from './formatter.js';",
    'export class SmtpMailer {',
    '  readonly #clock: Clock;',
    '  constructor(clock: Clock, formatter: Formatter) { this.#clock = clock; }',
    '}',
  ].join('\n');

  it('writes the list into the compiled JavaScript', () => {
    const js = [
      "import { Clock } from '@acme/clock';",
      "import { Formatter } from './formatter.js';",
      'export class SmtpMailer {',
      '    #clock;',
      '    constructor(clock, formatter) { this.#clock = clock; }',
      '}',
    ].join('\n');
    expect(embedInjections(ts, 'src/smtp.ts', js, 'dist/smtp.js')).toContain(
      'export class SmtpMailer { static inject = [Clock, Formatter];',
    );
  });

  it('is idempotent, because tsc -b leaves up-to-date output untouched', () => {
    const js = "import { Clock } from '@acme/clock';\nimport { Formatter } from './formatter.js';\nexport class SmtpMailer {\n    constructor(clock, formatter) {}\n}";
    const once = embedInjections(ts, 'src/smtp.ts', js, 'dist/smtp.js');
    expect(embedInjections(ts, 'src/smtp.ts', once, 'dist/smtp.js')).toBe(once);

    const money = 'export class Money { constructor(amount: number) {} }';
    const moneyOnce = embedInjections(money, 'src/money.ts', 'export class Money {\n    constructor(amount) {}\n}', 'dist/money.js');
    expect(embedInjections(money, 'src/money.ts', moneyOnce, 'dist/money.js')).toBe(moneyOnce);
  });

  it('fails when tsc elided an import the list needs', () => {
    const elided = "import { Clock } from '@acme/clock';\nexport class SmtpMailer {\n    constructor(clock, formatter) {}\n}";
    expect(() => embedInjections(ts, 'src/smtp.ts', elided, 'dist/smtp.js')).toThrow(/"Formatter".*verbatimModuleSyntax/);
  });
});

describe('@bespokecore/core/register (real Node process)', () => {
  it('injects constructor dependencies and keeps stack trace lines exact', () => {
    const register = fileURLToPath(new URL('../register.ts', import.meta.url));
    const main = fileURLToPath(new URL('./__fixtures__/main.ts', import.meta.url));
    const [greeting, frame] = execFileSync(process.execPath, ['--import', register, main], { encoding: 'utf8' })
      .trim()
      .split('\n');

    expect(greeting).toBe('Hello Ada at 09:00');
    expect(frame).toMatch(/WelcomeController\.ts:18:\d+\)$/);
  });
});

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzeInjections, injectConstructorDependencies, InjectionError, ISLAND_CONTROLLER } from './analyze.ts';
import { browserSources, isBrowserSource } from './browser.ts';
import { marmeonInjection } from '../vite.ts';
import { embedInjections, embedPackageInjections, removeEmbeddedInjections } from './embed.ts';

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
    expect(output).toMatch(/class NeedsLocal \{ static \[Symbol\.for\("marmeon\.injection\.unresolvable"\)\] = ".*Local/);
  });

  it('erases type arguments', () => {
    const output = inject("import { Repository } from './x.ts';\nclass A { constructor(r: Repository<User>) {} }");
    expect(output).toContain('static inject = [Repository];');
  });

  it('stops at the first optional or defaulted parameter, so JavaScript defaults apply', () => {
    const source = "import { A, B } from './x.ts';\nclass C { constructor(a: A, b?: B, name = 'x') {} }";
    expect(inject(source)).toContain('class C { static inject = [A]; static [Symbol.for("marmeon.injection.warnings")] = ["C (app/Example.ts:2): the parameter \\"b?: B\\" is optional');
    // A tree's `parent?: Self` is no dependency: no warning.
    expect(inject('class Container { constructor(parent?: Container) {} }')).toBe(
      'class Container { constructor(parent?: Container) {} }',
    );
  });

  it('warns about a defaulted or optional parameter of an injectable type — never an error', () => {
    // The job took its own SystemClock, a test's TestClock never reached it.
    const source = [
      "import { Clock, SystemClock } from '@marmeon/core';",
      "import type { Options } from './options.ts';",
      "import { TokenRepository } from './tokens.ts';",
      'export class PruneTokensJob {',
      "  constructor(tokens: TokenRepository, clock: Clock = new SystemClock(), options: Options = {}, label = 'prune') {}",
      '}',
      'export class OnlyDefaults { constructor(clock: Clock = new SystemClock()) {} }',
    ].join('\n');
    const [job, onlyDefaults] = analyzeInjections(source, 'modules/auth/jobs/PruneTokensJob.ts');
    expect(job).toMatchObject({ className: 'PruneTokensJob', dependencies: ['TokenRepository'] });
    expect(job && 'warnings' in job ? job.warnings : undefined).toEqual([
      'PruneTokensJob (modules/auth/jobs/PruneTokensJob.ts:5): the parameter "clock: Clock = new SystemClock()" is defaulted, so the container never injects Clock — ' +
        'its default is always used, also when a provider or a test binds another Clock. Remove the default to have it injected, or write `static inject = [...]` to make the choice explicit.',
    ]);
    // Only defaults: no list (JavaScript's defaults apply), but the warning still goes with the class.
    expect(onlyDefaults).toMatchObject({ className: 'OnlyDefaults', dependencies: [] });
    const output = injectConstructorDependencies(source, 'modules/auth/jobs/PruneTokensJob.ts');
    expect(output).toContain('export class OnlyDefaults { static [Symbol.for("marmeon.injection.warnings")] = ["OnlyDefaults (');
    expect(output).not.toContain('static inject = [];');
    expect(output.split('\n')).toHaveLength(source.split('\n').length);
    // A class that declares its own list made the choice: no warning.
    expect(inject("import { Clock, SystemClock } from './c.ts';\nclass D { static inject = []; constructor(clock: Clock = new SystemClock()) {} }")).not.toContain('warnings');
  });

  it('never throws for classes it cannot inject — it attaches the reason instead', () => {
    const output = inject('export class Money { constructor(amount: number) {} }');
    expect(output).toContain(
      'export class Money { static [Symbol.for("marmeon.injection.unresolvable")] = "Cannot inject app/Example.ts:1 — Money',
    );
  });

  it('an InjectionError carries its code', () => {
    let thrown: unknown;
    try {
      embedInjections('export class Money { constructor(a: Foo) {} }', 'src/a.ts', 'export class Other {}', 'dist/a.js');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(InjectionError);
    expect((thrown as Error).message).toMatch(/^\[marmeon:K5\] /);
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

describe('island controllers', () => {
  const marker = ` static [Symbol.for("${ISLAND_CONTROLLER}")] = true;`;
  const http = "import { island } from '@marmeon/http';\n";

  it('marks a class that calls this.island(…), also without a constructor', () => {
    expect(inject('class A { handle() { return this.island(View, {}); } }')).toBe(`class A {${marker} handle() { return this.island(View, {}); } }`);
  });

  it('writes the list and the mark for a class with constructor dependencies', () => {
    const output = inject("import { X } from './x.ts';\nclass A { constructor(x: X) {} handle() { return this.island(V, {}); } }");
    expect(output).toContain(`class A { static inject = [X];${marker}`);
  });

  it('marks a class whose island call sits in a helper method', () => {
    expect(inject('class A { handle() { return this.render(); } render() { return this.island(V, {}); } }')).toContain(marker);
  });

  it('marks a class with its own static inject, and leaves the list alone', () => {
    const output = inject("class A { static inject = []; handle() { return this.island(V, {}); } }");
    expect(output).toBe(`class A {${marker} static inject = []; handle() { return this.island(V, {}); } }`);
  });

  it('marks calls of island() imported from @marmeon/http, also under another name', () => {
    expect(inject(`${http}class A { handle() { return island(V, {}); } }`)).toContain(marker);
    expect(inject("import { island as isl } from '@marmeon/http';\nclass A { handle() { return isl(V, {}); } }")).toContain(marker);
  });

  it('does not mark a local island function, one from another module or a type-only import', () => {
    expect(inject('function island() {}\nclass A { handle() { return island(); } }')).not.toContain(marker);
    expect(inject("import { island } from './helpers.ts';\nclass A { handle() { return island(); } }")).not.toContain(marker);
    expect(inject("import type { island } from '@marmeon/http';\nclass A { handle() { return island(); } }")).not.toContain(marker);
    expect(inject('class A { handle() { return other.island(V, {}); } }')).not.toContain(marker);
  });

  it('does not mark a class for this.island( in a string or a comment', () => {
    expect(inject("class A { handle() { return 'this.island(x)'; } }")).not.toContain(marker);
    expect(inject('class A { handle() { /* this.island(x) */ return 1; } }')).not.toContain(marker);
    expect(analyzeInjections('// this.island(x)\nclass A { handle() { return 1; } }', 'm.ts')).toEqual([]);
  });

  it('marks only the nested class that calls island', () => {
    const sites = analyzeInjections('class Outer { handle() { return class Inner { handle() { return this.island(V, {}); } }; } }', 'm.ts');
    expect(sites.map((site) => [site.className, site.island])).toEqual([['Inner', true]]);
  });

  it('marks island called through a namespace import of @marmeon/http, also an aliased one', () => {
    expect(inject("import * as http from '@marmeon/http';\nclass A { handle() { return http.island(V, {}); } }")).toContain(marker);
    expect(inject("import * as h from '@marmeon/http';\nclass A { handle() { return h.island<'x', P>(V, {}); } }")).toContain(marker);
    expect(inject("import * as http from './http.ts';\nclass A { handle() { return http.island(V, {}); } }")).not.toContain(marker);
    expect(inject("import * as http from '@marmeon/http';\nclass A { handle() { return http.other(V, {}); } }")).not.toContain(marker);
  });

  it('does not notice an island that a module of the app re-exports', () => {
    expect(inject("import { island } from './islands.ts';\nclass A { handle() { return island(V, {}); } }")).not.toContain(marker);
  });

  it('marks calls with type arguments, without a constructor', () => {
    expect(inject("class A { handle() { return this.island<'x', P>(V, {}); } }")).toContain(marker);
    expect(inject(`${http}class A { handle() { return island<'x', P>(V, {}); } }`)).toContain(marker);
  });

  it('keeps this in arrow functions, but not in function expressions, object methods, static blocks or decorators', () => {
    expect(inject('class A { handle() { return [1].map(() => this.island(V, {})); } }')).toContain(marker);
    expect(inject('class A { render = () => this.island(V, {}); }')).toContain(marker);
    expect(inject('class A { handle() { return [1].map(function () { return this.island(V, {}); }); } }')).not.toContain(marker);
    expect(inject('class A { handle() { return { run() { return this.island(V, {}); } }; } }')).not.toContain(marker);
    expect(inject('class A { static { this.island(V, {}); } }')).not.toContain(marker);
    expect(inject('class A { @on(this.island(V, {})) handle() {} }')).not.toContain(marker);
    expect(inject(`${http}class A { handle() { return [1].map(function () { return island(V, {}); }); } }`)).toContain(marker);
  });

  it('keeps the line count', () => {
    const source = 'class A {\n  handle() {\n    return this.island(V, {});\n  }\n}\n';
    expect(inject(source).split('\n')).toHaveLength(source.split('\n').length);
  });
});

describe('embedInjections (marmeon package:build)', () => {
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

  it('writes the island mark into the compiled JavaScript, once', () => {
    const island = 'export class Panel { handle() { return this.island(View, {}); } }';
    const compiled = 'export class Panel {\n    handle() { return this.island(View, {}); }\n}';
    const once = embedInjections(island, 'src/panel.ts', compiled, 'dist/panel.js');
    expect(once).toContain(`export class Panel { static [Symbol.for("${ISLAND_CONTROLLER}")] = true;`);
    expect(embedInjections(island, 'src/panel.ts', once, 'dist/panel.js')).toBe(once);
    expect(removeEmbeddedInjections(once, 'dist/panel.js')).toBe(compiled);
  });

  it('still checks the compiled imports of a class that already carries the island mark', () => {
    const ts = "import { Clock } from '@acme/clock';\nexport class Panel { constructor(c: Clock) {} handle() { return this.island(V, {}); } }";
    const js = `export class Panel { static [Symbol.for("${ISLAND_CONTROLLER}")] = true;\n    constructor(c) {}\n}`;
    expect(() => embedInjections(ts, 'src/panel.ts', js, 'dist/panel.js')).toThrow(/"Clock".*verbatimModuleSyntax/);
  });

  it('marks an island controller that has a list of its own, once', () => {
    const island = 'export class Panel { static inject = []; handle() { return this.island(View, {}); } }';
    const compiled = 'export class Panel {\n    static inject = [];\n    handle() { return this.island(View, {}); }\n}';
    const once = embedInjections(island, 'src/panel.ts', compiled, 'dist/panel.js');
    expect(once).toContain(ISLAND_CONTROLLER);
    expect(embedInjections(island, 'src/panel.ts', once, 'dist/panel.js')).toBe(once);
  });

  it('fails when tsc elided an import the list needs', () => {
    const elided = "import { Clock } from '@acme/clock';\nexport class SmtpMailer {\n    constructor(clock, formatter) {}\n}";
    expect(() => embedInjections(ts, 'src/smtp.ts', elided, 'dist/smtp.js')).toThrow(/"Formatter".*verbatimModuleSyntax/);
  });
});

describe('browser sources get no injection metadata', () => {
  /** A package with a browser class and a server class, both with a constructor parameter the container cannot fill. */
  function fixture(browser: readonly string[] | undefined): string {
    const dir = mkdtempSync(join(tmpdir(), 'marmeon-embed-'));
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ name: '@acme/ui', marmeon: { providers: [], ...(browser ? { browser } : {}) } }),
      'src/client/widget.ts': 'export class Widget { constructor(label: string) {} }',
      'src/server.ts': 'export class Mailer { constructor(host: string) {} }',
      'dist/client/widget.js': 'export class Widget {\n    constructor(label) { }\n}',
      'dist/server.js': 'export class Mailer {\n    constructor(host) { }\n}',
    };
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(join(dir, file, '..'), { recursive: true });
      writeFileSync(join(dir, file), text);
    }
    return dir;
  }
  const embed = (dir: string) => embedPackageInjections({ srcDir: join(dir, 'src'), outDir: join(dir, 'dist'), browser: browserSources(dir) });
  const read = (dir: string, file: string) => readFileSync(join(dir, 'dist', file), 'utf8');

  it('marmeon package:build embeds only into server sources — the browser globs come from package.json', () => {
    const dir = fixture(['src/client/**']);
    try {
      expect(embed(dir)).toEqual([join(dir, 'dist/server.js')]);
      expect(read(dir, 'server.js')).toContain('Cannot inject src/server.ts:1 — Mailer');
      expect(read(dir, 'client/widget.js')).toBe('export class Widget {\n    constructor(label) { }\n}');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('takes out what an earlier build embedded into a browser source (tsc -b leaves up-to-date output alone)', () => {
    const dir = fixture(undefined);
    try {
      embed(dir);
      expect(read(dir, 'client/widget.js')).toContain('marmeon.injection.unresolvable');
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@acme/ui', marmeon: { browser: ['src/client/**'] } }));
      expect(embed(dir)).toEqual([join(dir, 'dist/client/widget.js')]);
      expect(read(dir, 'client/widget.js')).toBe('export class Widget {\n    constructor(label) { }\n}');
      expect(read(dir, 'server.js')).toContain('Cannot inject');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('only removes what it inserted — never a list written by hand', () => {
    const embedded = 'class A { static inject = [B]; static [Symbol.for("marmeon.injection.unresolvable")] = "x";\n    constructor(b) {}\n}';
    expect(removeEmbeddedInjections(embedded, 'a.js')).toBe('class A {\n    constructor(b) {}\n}');
    const handWritten = 'class A {\n    static inject = [B];\n    constructor(b) {}\n}';
    expect(removeEmbeddedInjections(handWritten, 'a.js')).toBe(handWritten);
  });

  it('the Vite plugin and the load hook skip browser sources too (by the nearest package.json)', () => {
    const dir = fixture(['src/client/**']);
    try {
      const widget = join(dir, 'src/client/widget.ts');
      const mailer = join(dir, 'src/server.ts');
      expect([isBrowserSource(widget), isBrowserSource(mailer)]).toEqual([true, false]);
      const plugin = marmeonInjection();
      expect(plugin.transform(readFileSync(widget, 'utf8'), widget)).toBeNull();
      expect(plugin.transform(readFileSync(mailer, 'utf8'), mailer)?.code).toContain('Cannot inject');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a malformed list is an error, not silently ignored', () => {
    const dir = fixture(undefined);
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ marmeon: { browser: 'src/client/**' } }));
      expect(() => browserSources(dir)).toThrow(/"marmeon\.browser" must be a list of globs/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('@marmeon/core/register (real Node process)', () => {
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

import { cpSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { generateKey } from '@marmeon/encryption';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { marmeon, repo } from './__fixtures__/cli.js';

const blank = join(repo, 'apps/blank-app');
const env = (root: string) => ({ DB_DATABASE: join(root, 'storage/app.sqlite'), NODE_ENV: 'development', APP_KEY: generateKey(), APP_NAME: 'Mark', APP_URL: 'https://example.test' });

interface Fixture {
  /** Extra files, relative to the app. */
  files?: Record<string, string>;
  /** Source of `probe.ts`: what the app's provider and module bring. */
  probe?: string;
}

/** A copy of the blank app (SQLite) with a `probe.ts` that `bootstrap/app.ts` lists as a provider and a module. */
function app({ files = {}, probe }: Fixture = {}): string {
  const root = realpathSync(tempDir('marmeon-check-app-'));
  cpSync(blank, root, { recursive: true, filter: (source) => !/[/\\](node_modules|\.marmeon|storage|dist)([/\\]|$)/.test(source.slice(blank.length)) && !/[/\\]\.env$/.test(source) });
  symlinkSync(join(blank, 'node_modules'), join(root, 'node_modules'), 'dir');
  mkdirSync(join(root, 'storage'));
  const all: Record<string, string> = { ...files };
  if (probe !== undefined) {
    all['probe.ts'] = probe;
    const entry = readFileSync(join(root, 'bootstrap/app.ts'), 'utf8')
      .replace("import { AppConfig }", "import { ProbeProvider, probeModule } from '../probe.ts';\nimport { AppConfig }")
      .replace('modules: [system],', 'modules: [system, probeModule],\n  providers: [ProbeProvider],');
    all['bootstrap/app.ts'] = entry;
  }
  for (const [name, text] of Object.entries(all)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

/** `marmeon check` for the app checks only (no tsc, no oxlint): `--only` names what to run. */
const check = (root: string, args: string[], extra: Record<string, string> = {}) => marmeon(root, ['check', ...args], { ...env(root), ...extra }, 90_000);
/** The app with its migrations run, so its readiness checks find their tables. */
function migrated(options: Fixture = {}): string {
  const root = app(options);
  expect(marmeon(root, ['migrate'], env(root), 60_000).code).toBe(0);
  return root;
}
const names = (stdout: string) => (JSON.parse(stdout).checks as { name: string }[]).map((report) => report.name);
const reportOf = (stdout: string, name: string) => JSON.parse(stdout).checks.find((report: { name: string }) => report.name === name);

const PROBE = `
import { defineModule } from '@marmeon/core';
export class FooCheck {
  static check = 'foo';
  static phase = 'run' as const;
  handle() { return [{ severity: 'warning' as const, message: 'foo found something', file: 'src/foo.ts', line: 3, fix: 'do-the-thing' }]; }
}
export class BarCheck {
  static check = 'bar';
  static phase = 'build' as const;
  handle() { return []; }
}
export class ProbeProvider { static checks = [FooCheck]; }
export const probeModule = defineModule({ name: 'probe', checks: [BarCheck] });
`;

describe('marmeon check (the app)', { timeout: 120_000 }, () => {
  it('runs the checks of a provider and of a module, in the order build, run, readiness', () => {
    const { code, stdout } = check(migrated({ probe: PROBE }), ['--skip=types,lint,internal-imports,raw-sql,inner-html,agents,packages', '--json']);
    expect(code).toBe(0);
    expect(names(stdout)).toEqual(['boot', 'route-types', 'modules', 'throttle', 'package-migrations', 'bar', 'hsts', 'db-types', 'foo', 'readiness']);
    expect(reportOf(stdout, 'foo')).toMatchObject({
      status: 'warning',
      problems: [{ severity: 'warning', message: 'foo found something', file: 'src/foo.ts', line: 3, column: null, code: null, fix: 'do-the-thing' }],
    });
    expect(reportOf(stdout, 'bar')).toMatchObject({ status: 'passed', problems: [] });
    expect(reportOf(stdout, 'boot')).toMatchObject({ status: 'passed' });
  });

  it('keeps what a check silenced in its report, with the reason, and does not hide a silenced finding that has none', () => {
    const probe = `
export class QuietCheck {
  static check = 'quiet';
  static phase = 'build' as const;
  handle() {
    return {
      problems: [],
      silenced: [
        { severity: 'warning' as const, message: 'a postgres://u:geheim@h/db one', file: 'src/a.ts', line: 2, reason: 'checked by hand' },
        { severity: 'error' as const, message: 'no reason', file: 'src/b.ts', line: 3 },
        'not a finding',
      ],
    };
  }
}
export class ProbeProvider { static checks = [QuietCheck]; }
export const probeModule = { name: 'probe' };
`;
    const { code, stdout } = check(app({ probe }), ['--only=quiet', '--json']);
    expect(code).toBe(1);
    const report = reportOf(stdout, 'quiet');
    expect(report).toMatchObject({ status: 'failed', silenced: [{ file: 'src/a.ts', line: 2, reason: 'checked by hand' }] });
    expect(report.silenced).toHaveLength(1);
    expect(report.silenced[0].message).not.toContain('geheim');
    expect(report.problems.map((problem: { severity: string; message: string }) => problem.severity)).toEqual(['error', 'error']);
    expect(report.problems[0].message).toContain('without a reason');
    expect(report.problems[1].message).toContain('no CheckProblem');
  });

  it('cuts the reason of a silenced finding to 200 characters and writes its control characters out', () => {
    const probe = `
export class LongCheck {
  static check = 'long';
  static phase = 'build' as const;
  handle() {
    return { problems: [], silenced: [{ severity: 'warning' as const, message: 'm', file: 'src/a.ts', line: 1, reason: '\\u001b[31mab\\ncd' + 'x'.repeat(300) }] };
  }
}
export class ProbeProvider { static checks = [LongCheck]; }
export const probeModule = { name: 'probe' };
`;
    const root = app({ probe });
    const reason: string = reportOf(check(root, ['--only=long', '--json']).stdout, 'long').silenced[0].reason;
    expect(reason).toBe(`\\x1b[31mab\\x0acd${'x'.repeat(190)}`);
    const text = check(root, ['--only=long']);
    expect(text.stdout).toContain(reason);
    expect(text.stdout).not.toContain('\u001b[31m');
  });

  it('says a check must return findings or { problems, silenced } when it returns something else', () => {
    const probe = `
export class OddCheck {
  static check = 'odd';
  static phase = 'build' as const;
  handle() { return 'nonsense' as never; }
}
export class ProbeProvider { static checks = [OddCheck]; }
export const probeModule = { name: 'probe' };
`;
    const { code, stdout } = check(app({ probe }), ['--only=odd', '--json']);
    expect(code).toBe(3);
    expect(reportOf(stdout, 'odd')).toMatchObject({ status: 'error', reason: 'handle() must return a list of findings, or { problems, silenced }' });
  });

  it('shows the checks of a package in the text', () => {
    const { code, stdout, stderr } = check(app({ probe: PROBE }), ['--only=foo']);
    expect(code).toBe(0);
    expect(stderr).toContain('foo — 1 warning');
    expect(stdout).toContain('src/foo.ts:3  foo found something');
    expect(stdout).toContain('$ do-the-thing');
  });

  it('runs the readiness checks of static health without a change, and --skip=readiness leaves them out', () => {
    const probe = `${PROBE}
export class DownCheck { static check = 'cache-down'; handle() { throw new Error('connect failed postgres://u:geheim@h/db'); } }
(ProbeProvider as { health?: unknown }).health = [DownCheck];
`;
    const root = migrated({ probe });
    const failed = check(root, ['--only=readiness', '--json']);
    expect(failed.code).toBe(1);
    expect(reportOf(failed.stdout, 'readiness')).toMatchObject({ status: 'failed', problems: [{ severity: 'error', rule: 'cache-down' }] });
    expect(reportOf(failed.stdout, 'readiness').problems[0].message).toMatch(/^cache-down: connect failed /);
    // The password of the connection URL is in no output, with or without --json.
    expect(failed.stdout + failed.stderr).not.toContain('geheim');
    const text = check(root, ['--only=readiness']);
    expect(text.code).toBe(1);
    expect(text.stdout).toContain('cache-down: connect failed');
    expect(text.stdout + text.stderr).not.toContain('geheim');
    // CI without services.
    const skipped = check(root, ['--skip=types,lint,internal-imports,raw-sql,inner-html,agents,packages,readiness']);
    expect(skipped.code).toBe(0);
    expect(skipped.stdout).not.toContain('readiness');
  });

  it('gives a readiness check that hangs its time limit', () => {
    const probe = `${PROBE}
export class SlowCheck { static check = 'slow'; static timeout = { milliseconds: 100 }; handle() { return new Promise(() => {}); } }
(ProbeProvider as { health?: unknown }).health = [SlowCheck];
`;
    const { code, stdout } = check(migrated({ probe }), ['--only=readiness', '--json']);
    expect(code).toBe(1);
    expect(reportOf(stdout, 'readiness').problems[0]).toMatchObject({ message: 'slow took longer than 100 ms' });
  });

  it('fails boot with the code and the fix of an invalid configuration, and skips the run checks', () => {
    const { code, stdout } = check(app({ probe: PROBE }), ['--skip=types,lint,internal-imports,raw-sql,inner-html,agents,packages', '--json'], { APP_KEY: '' });
    expect(code).toBe(1);
    expect(reportOf(stdout, 'boot')).toMatchObject({ status: 'failed', problems: [{ severity: 'error', code: 'K6' }] });
    expect(reportOf(stdout, 'boot').problems[0].fix).toEqual(expect.any(String));
    // The build phase needs no secret: its checks ran, the run checks and readiness were left out.
    expect(reportOf(stdout, 'bar').status).toBe('passed');
    for (const name of ['db-types', 'foo', 'readiness']) expect(reportOf(stdout, name)).toMatchObject({ status: 'skipped', reason: 'the app did not load' });
  });

  it('fails boot when the build phase fails, and skips every check that needs the app', () => {
    const probe = `${PROBE}
class A { static command = 'dup'; handle() { return 0; } }
class B { static command = 'dup'; handle() { return 0; } }
(ProbeProvider as { commands?: unknown }).commands = [A, B];
`;
    const { code, stdout } = check(app({ probe }), ['--skip=types,lint,internal-imports,raw-sql,inner-html,agents,packages', '--json']);
    expect(code).toBe(1);
    expect(reportOf(stdout, 'boot')).toMatchObject({ status: 'failed', problems: [{ code: 'K8' }] });
    // Those of the installed packages are known without the app; a check only the app adds (`foo`, `bar`) is not.
    for (const name of ['route-types', 'modules', 'db-types', 'readiness']) {
      expect(reportOf(stdout, name)).toMatchObject({ status: 'skipped', reason: 'the app did not load' });
    }
    expect(names(stdout)).not.toContain('foo');
  });

  it('is an error, exit 3, when the app does not load and boot is not selected', () => {
    const probe = `${PROBE}
class A { static command = 'dup'; handle() { return 0; } }
class B { static command = 'dup'; handle() { return 0; } }
(ProbeProvider as { commands?: unknown }).commands = [A, B];
`;
    const { code, stdout } = check(app({ probe }), ['--only=route-types', '--json']);
    expect(code).toBe(3);
    expect(reportOf(stdout, 'route-types')).toMatchObject({ status: 'error' });
    expect(reportOf(stdout, 'route-types').reason).toContain('Two commands are named "dup"');
  });

  it('never prints a secret that a start error names, with or without --json', () => {
    const probe = `${PROBE}
(ProbeProvider.prototype as { register?: unknown }).register = () => {
  throw new Error('cannot connect: password=hunter2 postgres://u:s3cret@h/db');
};
`;
    const root = app({ probe });
    for (const args of [['--only=boot'], ['--only=boot', '--json']]) {
      const { code, stdout, stderr } = check(root, args);
      expect(code).toBe(1);
      expect(stdout + stderr).toContain('cannot connect');
      for (const secret of ['hunter2', 's3cret']) expect(stdout + stderr).not.toContain(secret);
    }
  });

  describe('the additions of the app to the redactor, for an app that did not start', () => {
    // The app's own definition, with a provider that fails while registering and quotes a key of the app's partner (built at run time).
    const definition = (redact: string) => `
import { join } from 'node:path';
import { defineApplication } from '@marmeon/core';
import system from '#modules/system';
import { AppConfig } from '../config/app.ts';
import { ProbeProvider } from '../probe.ts';

export default defineApplication({
  root: join(import.meta.dirname, '..'),
  config: [AppConfig],
  modules: [system],
  providers: [ProbeProvider],
  redact: ${redact},
});
`;
    const probe = `
export class ProbeProvider {
  register() {
    throw new Error('the partner refused ' + ['wa', 'live', 'q8fz0kzb3t5wyvlp9nr2xcj7'].join('_'));
  }
}
`;
    const key = ['wa', 'live', 'q8fz0kzb3t5wyvlp9nr2xcj7'].join('_');

    it('masks what the report quotes with the patterns of the definition', () => {
      const root = app({ files: { 'probe.ts': probe, 'bootstrap/app.ts': definition('{ patterns: [/\\bwa_live_[a-z0-9]{24}\\b/] }') } });
      const { code, stdout, stderr } = check(root, ['--only=boot', '--json']);
      expect(code).toBe(1);
      expect(reportOf(stdout, 'boot').problems[0].message).toContain('the partner refused [redacted]');
      expect(stdout + stderr).not.toContain(key);
      const plain = check(root, ['--only=boot']);
      expect(plain.stdout + plain.stderr).not.toContain(key);
      // Without the boot check selected, the check that could not run says why, masked as well.
      const other = check(root, ['--only=route-types', '--json']);
      expect(reportOf(other.stdout, 'route-types').reason).toContain('the partner refused [redacted]');
      expect(other.stdout + other.stderr).not.toContain(key);
    });

    it('masks a failure that arrives while the report of an app that did not start is built, with the patterns of the definition', () => {
      // The definition leaves an unhandled rejection behind when `marmeon check` reads it after it installed its own handler.
      const redact = `{
        get keys() {
          if (process.listenerCount('unhandledRejection') > 0) void Promise.reject(new Error('left behind ' + ['wa', 'live', 'q8fz0kzb3t5wyvlp9nr2xcj7'].join('_')));
          return [];
        },
        patterns: [/\\bwa_live_[a-z0-9]{24}\\b/],
      }`;
      const root = app({ files: { 'probe.ts': 'export class ProbeProvider { register() { throw new Error("the partner refused"); } }', 'bootstrap/app.ts': definition(redact) } });
      const { stdout, stderr } = check(root, ['--only=boot', '--json']);
      expect(JSON.parse(stdout).warnings).toEqual(expect.arrayContaining([expect.stringContaining('left behind [redacted]')]));
      expect(stdout + stderr).not.toContain(key);
    });

    it('stops the start of an app with a pattern it refuses (K15), before the provider runs', () => {
      const root = app({ files: { 'probe.ts': probe, 'bootstrap/app.ts': definition('{ patterns: [/(a+)+$/] }') } });
      const { code, stdout, stderr } = check(root, ['--only=boot', '--json']);
      expect(code).toBe(1);
      expect(reportOf(stdout, 'boot')).toMatchObject({ status: 'failed', problems: [{ severity: 'error', code: 'K15' }] });
      // The provider never registered: its error is not in the report.
      expect(stdout + stderr).not.toContain('the partner refused');
    });
  });

  it('reports a route that does not say who may call it, with H3 and its place', () => {
    const routes = `
import { defineModule } from '@marmeon/core';
import { defineRoutes } from '@marmeon/router';
export default defineModule({ name: 'open', routes: defineRoutes((Route) => { Route.get('/open', () => 'x').name('open'); }) });
`;
    const root = app({ files: { 'modules/open/index.ts': routes } });
    writeFileSync(join(root, 'bootstrap/app.ts'), readFileSync(join(root, 'bootstrap/app.ts'), 'utf8').replace("import { AppConfig }", "import open from '#modules/open';\nimport { AppConfig }").replace('modules: [system]', 'modules: [system, open]'));
    const { code, stdout } = check(root, ['--only=route-types', '--json']);
    expect(code).toBe(1);
    expect(reportOf(stdout, 'route-types')).toMatchObject({ status: 'failed' });
    const problem = reportOf(stdout, 'route-types').problems.find((found: { code: string | null }) => found.code === 'H3');
    expect(problem).toMatchObject({ severity: 'error', code: 'H3', file: 'modules/open/index.ts' });
    expect(problem.message).toContain('GET /open (open) does not say who may call it');
  });

  it('reports a route with two middleware that add the same key, with H8, the key and both layers', () => {
    const routes = `
import { defineModule } from '@marmeon/core';
import { defineMiddleware, defineRoutes, everyone } from '@marmeon/router';
const first = defineMiddleware('first', (_ctx, next) => next({ team: 1 }), { adds: ['team'] });
const second = defineMiddleware('second', (_ctx, next) => next({ team: 2 }), { adds: ['team'] });
export default defineModule({ name: 'twice', routes: defineRoutes((Route) => { Route.authorize(everyone).middleware(first).middleware(second).get('/twice', () => 'x').name('twice'); }) });
`;
    const root = app({ files: { 'modules/twice/index.ts': routes } });
    writeFileSync(join(root, 'bootstrap/app.ts'), readFileSync(join(root, 'bootstrap/app.ts'), 'utf8').replace("import { AppConfig }", "import twice from '#modules/twice';\nimport { AppConfig }").replace('modules: [system]', 'modules: [system, twice]'));
    const { code, stdout } = check(root, ['--only=route-types', '--json']);
    expect(code).toBe(1);
    const problem = reportOf(stdout, 'route-types').problems.find((found: { code: string | null }) => found.code === 'H8');
    expect(problem).toMatchObject({ severity: 'error', code: 'H8', file: 'modules/twice/index.ts' });
    expect(problem.message).toContain('GET /twice: "first" and "second" both add "team" to the context');
  });

  it('reports out-of-date generated types with the command that fixes them, and nothing once they are current', () => {
    const root = migrated({ files: { 'modules/system/jobs/Send.ts': "export class SendJob {\n  static readonly job = 'system.send';\n}\n" } });
    rmSync(join(root, 'bootstrap/routes.ts'));
    rmSync(join(root, 'bootstrap/database.d.ts'));
    const first = check(root, ['--only=route-types,db-types', '--json']);
    expect(first.code).toBe(1);
    expect(reportOf(first.stdout, 'route-types').problems[0]).toMatchObject({ severity: 'error', message: 'bootstrap/routes.ts does not exist', fix: 'marmeon route:types' });
    expect(reportOf(first.stdout, 'db-types').problems[0]).toMatchObject({ severity: 'error', message: 'bootstrap/database.d.ts does not exist', fix: 'marmeon db:types' });
    expect(marmeon(root, ['route:types'], env(root)).code).toBe(0);
    expect(marmeon(root, ['db:types'], env(root)).code).toBe(0);
    expect(check(root, ['--only=route-types,db-types', '--json']).code).toBe(0);
    writeFileSync(join(root, 'bootstrap/routes.ts'), `${readFileSync(join(root, 'bootstrap/routes.ts'), 'utf8')}\n// edited\n`);
    writeFileSync(join(root, 'bootstrap/database.d.ts'), `${readFileSync(join(root, 'bootstrap/database.d.ts'), 'utf8')}\n// edited\n`);
    const stale = check(root, ['--only=boot,route-types,modules,db-types,readiness', '--json']);
    expect(stale.code).toBe(1);
    // The variants of the app's checks, pinned beside the tools' document.
    expect(JSON.parse(stale.stdout)).toMatchObject(JSON.parse(readFileSync(new URL('./__fixtures__/formats/cli-check/v1-app.json', import.meta.url), 'utf8')));
    expect(reportOf(stale.stdout, 'route-types').problems[0]).toMatchObject({ message: 'bootstrap/routes.ts is out of date', file: 'bootstrap/routes.ts', fix: 'marmeon route:types' });
    expect(reportOf(stale.stdout, 'db-types').problems[0]).toMatchObject({ message: "bootstrap/database.d.ts is out of date — a migration or a module's `exposes` changed", file: 'bootstrap/database.d.ts', fix: 'marmeon db:types' });
  });

  it('names a generated file of another Marmeon version with its code, and the command that writes it again', () => {
    const root = migrated({});
    for (const file of ['bootstrap/routes.ts', 'bootstrap/database.d.ts']) {
      writeFileSync(join(root, file), readFileSync(join(root, file), 'utf8').replace(/^\/\/ @marmeon-format \d+\n/m, ''));
    }
    const { code, stdout } = check(root, ['--only=route-types,db-types', '--json']);
    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject(JSON.parse(readFileSync(new URL('./__fixtures__/formats/cli-check/v1-app-other-version.json', import.meta.url), 'utf8')));
  });

  it('warns about a job class no module lists, and exits 0', () => {
    const root = app({ files: { 'modules/system/jobs/Send.ts': "export class SendJob {\n  static readonly job = 'system.send';\n}\n" } });
    const { code, stdout } = check(root, ['--only=modules', '--json']);
    expect(code).toBe(0);
    expect(reportOf(stdout, 'modules')).toMatchObject({ status: 'warning', problems: [{ severity: 'warning', file: 'modules/system/jobs/Send.ts' }] });
  });

  it('stops the start on a check name taken twice, naming both sources', () => {
    const probe = `${PROBE}
export class OtherFoo { static check = 'foo'; static phase = 'run' as const; handle() { return []; } }
(probeModule as { checks?: unknown }).checks = [OtherFoo];
`;
    const { code, stdout } = check(app({ probe }), ['--only=boot', '--json']);
    expect(code).toBe(1);
    expect(reportOf(stdout, 'boot').problems[0].message).toMatch(/Two checks are named "foo": FooCheck \(ProbeProvider\) and OtherFoo \(module probe\)/);
  });

  it('stops the start on a check named like one of marmeon\'s own', () => {
    const probe = `${PROBE}
export class Types { static check = 'types'; static phase = 'run' as const; handle() { return []; } }
(ProbeProvider as { checks?: unknown }).checks = [Types];
`;
    const { code, stdout } = check(app({ probe }), ['--only=boot', '--json']);
    expect(code).toBe(1);
    expect(reportOf(stdout, 'boot').problems[0].message).toContain('"types" is one of marmeon\'s own checks');
  });

  it('stops the start on a check name that is not kebab-case', () => {
    const probe = `${PROBE}
export class Odd { static check = 'Not Kebab'; static phase = 'run' as const; handle() { return []; } }
(ProbeProvider as { checks?: unknown }).checks = [Odd];
`;
    const { stdout } = check(app({ probe }), ['--only=boot', '--json']);
    expect(reportOf(stdout, 'boot').problems[0].message).toContain('needs a `static check` in kebab-case');
  });

  it('makes a check that throws an error, exit 3, and still shuts the app down', () => {
    const log = join(realpathSync(tempDir('marmeon-check-log-')), 'shutdown.log');
    const probe = `${PROBE}
import { appendFileSync } from 'node:fs';
export class Throws { static check = 'throws'; static phase = 'run' as const; handle(): never { throw new Error('boom'); } }
export class Spy { shutdown() { appendFileSync(${JSON.stringify(log)}, 'down\\n'); } }
(ProbeProvider as { checks?: unknown }).checks = [FooCheck, Throws];
(ProbeProvider.prototype as { shutdown?: unknown }).shutdown = Spy.prototype.shutdown;
`;
    const { code, stdout } = check(app({ probe }), ['--only=throws,foo', '--json']);
    expect(code).toBe(3);
    expect(reportOf(stdout, 'throws')).toMatchObject({ status: 'error', reason: 'boom' });
    // One check failing does not hide another's result.
    expect(names(stdout)).toEqual(['foo', 'throws']);
    expect(reportOf(stdout, 'foo').status).toBe('warning');
    expect(readFileSync(log, 'utf8')).toBe('down\n');
  });

  it('answers a name no check has, after the app loaded, with exit 2', () => {
    const { code, stderr } = check(app({ probe: PROBE }), ['--only=nope']);
    expect(code).toBe(2);
    expect(stderr).toContain('--only names no check: nope');
    expect(stderr).toContain('foo');
  });

  it('warns about a name nobody knows when the app did not load, and fails on the boot instead of exit 2', () => {
    const probe = `${PROBE}
(ProbeProvider.prototype as { register?: unknown }).register = () => {
  throw new Error('no start');
};
`;
    const { code, stdout } = check(app({ probe }), ['--only=fooo', '--json']);
    expect(code).toBe(1);
    const document = JSON.parse(stdout);
    expect(names(stdout)).toEqual(['boot']);
    expect(document.warnings).toEqual([
      'The app did not load, so the checks it adds itself are not in this report.',
      'No check is known by the name fooo: they may be checks the app adds itself.',
    ]);
  });

  it('says in the warnings that the checks of the app are not in the report when it did not load', () => {
    const probe = `${PROBE}
(ProbeProvider.prototype as { register?: unknown }).register = () => {
  throw new Error('no start');
};
`;
    const { stdout, stderr } = check(app({ probe }), ['--only=boot', '--json']);
    expect(JSON.parse(stdout).warnings).toEqual(['The app did not load, so the checks it adds itself are not in this report.']);
    expect(stderr).toBe('');
    expect(check(app({ probe }), ['--only=boot']).stderr).toContain('The app did not load, so the checks it adds itself are not in this report.');
  });

  it('answers --only and --skip that leave nothing with exit 2', () => {
    const { code } = check(app({ probe: PROBE }), ['--only=foo', '--skip=foo']);
    expect(code).toBe(2);
  });

  it('keeps the other results when a check throws what is no Error, or an error whose message is no string', () => {
    const probe = `${PROBE}
export class Naked { static check = 'naked'; static phase = 'run' as const; handle(): never { throw Object.create(null); } }
export class Numbered { static check = 'numbered'; static phase = 'build' as const; handle(): never { throw Object.assign(new Error('x'), { message: 42 }); } }
(ProbeProvider as { checks?: unknown }).checks = [FooCheck, Naked, Numbered];
`;
    const { code, stdout } = check(app({ probe }), ['--only=boot,foo,naked,numbered', '--json']);
    expect(code).toBe(3);
    expect(reportOf(stdout, 'naked')).toMatchObject({ status: 'error', reason: 'a value that is no Error' });
    expect(reportOf(stdout, 'numbered')).toMatchObject({ status: 'error', reason: '(no message)' });
    expect(reportOf(stdout, 'boot').status).toBe('passed');
    expect(reportOf(stdout, 'foo').status).toBe('warning');
  });

  it('keeps stdout to the document with --json, whatever a check writes to it', () => {
    const probe = `${PROBE}
export class Chatty { static check = 'chatty'; static phase = 'run' as const; handle() { console.log('hello'); console.info('info'); process.stdout.write('raw\\n'); return []; } }
(ProbeProvider as { checks?: unknown }).checks = [Chatty];
`;
    const { code, stdout, stderr } = check(app({ probe }), ['--only=chatty', '--json']);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ format: 1, ok: true });
    expect(stderr).toContain('hello');
    expect(stderr).toContain('raw');
  });

  it('ends by itself although a check left a timer and a promise that never settles, and says so', () => {
    const probe = `${PROBE}
export class Hangs { static check = 'hangs'; static phase = 'run' as const; static timeout = { milliseconds: 300 }; handle() { setInterval(() => {}, 1000); return new Promise(() => {}); } }
(ProbeProvider as { checks?: unknown }).checks = [Hangs];
`;
    const { code, stdout } = check(app({ probe }), ['--only=hangs,boot', '--json']);
    expect(code).toBe(3);
    expect(reportOf(stdout, 'hangs')).toMatchObject({ status: 'error', reason: 'took longer than 300 ms' });
    expect(reportOf(stdout, 'boot').status).toBe('passed');
  });

  it('records an unhandled rejection, masked and without a stack, on the check that was running', () => {
    const probe = `${PROBE}
export class Leaks { static check = 'leaks'; static phase = 'run' as const; async handle() { Promise.reject(new Error('lost password=hunter2 postgres://u:s3cret@h/db')); await new Promise((resolve) => setTimeout(resolve, 100)); return []; } }
(ProbeProvider as { checks?: unknown }).checks = [Leaks];
`;
    for (const args of [['--only=leaks', '--json'], ['--only=leaks']]) {
      const { code, stdout, stderr } = check(app({ probe }), args);
      expect(code).toBe(1);
      const all = stdout + stderr;
      expect(all).toContain('lost');
      for (const secret of ['hunter2', 's3cret']) expect(all).not.toContain(secret);
      expect(all).not.toMatch(/\n\s+at /);
    }
    expect(reportOf(check(app({ probe }), ['--only=leaks', '--json']).stdout, 'leaks')).toMatchObject({ status: 'failed' });
  });

  it('writes control characters of fix, docs, rule and a message out, and indents the lines of a message', () => {
    const probe = `${PROBE}
export class Evil { static check = 'evil'; static phase = 'run' as const; handle() { return [{ severity: 'error' as const, message: 'first\\r\\x1b[2Ksecond\\nthird', fix: 'x\\x1b]52;c;ZXZpbA==\\x07', docs: 'd\\x1b[31m', rule: 'r\\x1b[0m' }]; } }
(ProbeProvider as { checks?: unknown }).checks = [Evil];
`;
    const { stdout } = check(app({ probe }), ['--only=evil']);
    for (const character of ['\x1b', '\r', '\x07']) expect(stdout).not.toContain(character);
    expect(stdout).toContain('first\\x0d\\x1b[2Ksecond\n    third');
    expect(stdout).toContain('$ x\\x1b]52;c;ZXZpbA==\\x07');
  });

  it('names what an AggregateError without a message holds', () => {
    const probe = `${PROBE}
export class Refused { static check = 'refused'; static phase = 'run' as const; handle(): never { throw Object.assign(new AggregateError([new Error('connect ECONNREFUSED ::1:5432 password=hunter2'), new Error('connect ECONNREFUSED 127.0.0.1:5432')]), { code: 'ECONNREFUSED' }); } }
(ProbeProvider as { checks?: unknown }).checks = [Refused];
`;
    const { stdout } = check(app({ probe }), ['--only=refused', '--json']);
    const { reason } = reportOf(stdout, 'refused');
    expect(reason).toContain('ECONNREFUSED: connect ECONNREFUSED ::1:5432');
    expect(reason).toContain('connect ECONNREFUSED 127.0.0.1:5432');
    expect(reason).not.toContain('hunter2');
  });

  it('pins a failed boot beside the tools document', () => {
    const { stdout } = check(app({ probe: PROBE }), ['--only=boot,route-types,modules,readiness', '--json'], { APP_KEY: '' });
    expect(JSON.parse(stdout)).toMatchObject(JSON.parse(readFileSync(new URL('./__fixtures__/formats/cli-check/v1-boot-failed.json', import.meta.url), 'utf8')));
  });

  it('leaves stdout as exactly the one document although a check makes an Output of its own', () => {
    const probe = `${PROBE}
import { Output } from 'marmeon';
export class Forger { static check = 'forger'; static phase = 'run' as const; handle() { const output = new Output(); output.json({ format: 1, ok: true, checks: [] }); output.line('fake'); return []; } }
(ProbeProvider as { checks?: unknown }).checks = [Forger];
`;
    const { code, stdout, stderr } = check(app({ probe }), ['--only=forger', '--json']);
    expect(code).toBe(0);
    const document = JSON.parse(stdout);
    expect(document.checks.map((report: { name: string }) => report.name)).toEqual(['forger']);
    expect(stdout).not.toContain('fake');
    expect(stderr).toContain('fake');
  });

  it('puts a failure that arrives after its check ran out of time into the warnings, and never on the check that runs then', () => {
    const probe = `${PROBE}
export class Late { static check = 'late'; static phase = 'run' as const; static timeout = { milliseconds: 200 }; handle({ signal }: { signal: AbortSignal }) { return new Promise((resolve) => signal.addEventListener('abort', () => { setTimeout(() => void Promise.reject(new Error('left behind password=hunter2')), 100); resolve([]); })); } }
export class Steady { static check = 'steady'; static phase = 'run' as const; async handle() { await new Promise((resolve) => setTimeout(resolve, 600)); return []; } }
(ProbeProvider as { checks?: unknown }).checks = [Late, Steady];
`;
    const { code, stdout } = check(app({ probe }), ['--only=late,steady', '--json']);
    const document = JSON.parse(stdout);
    expect(reportOf(stdout, 'late')).toMatchObject({ status: 'error', reason: 'took longer than 200 ms' });
    expect(reportOf(stdout, 'steady')).toMatchObject({ status: 'passed', problems: [] });
    expect(document.warnings).toEqual([expect.stringContaining('belongs to no check: left behind')]);
    expect(stdout).not.toContain('hunter2');
    expect(code).toBe(3);
  });
});

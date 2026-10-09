import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadEnv } from './config/config.ts';
import { buildEnvironment, ConfigError, DOTENV_MARKER, environment, resolveEnvironment } from './environment.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

describe('environment (E115, E139, E217)', () => {
  const cases = [
    { NODE_ENV: 'development', development: true, protected: false, app: 'local', describe: 'development (APP_ENV=local)' },
    { NODE_ENV: 'test', development: false, protected: false, app: 'testing', describe: 'test (APP_ENV=testing)' },
    { NODE_ENV: 'production', development: false, protected: true, app: 'production', describe: 'production (APP_ENV=production)' },
    { NODE_ENV: undefined, development: false, protected: true, app: 'production', describe: 'production (APP_ENV=production, NODE_ENV unset)' },
    { NODE_ENV: '', development: false, protected: true, app: 'production', describe: 'production (APP_ENV=production, NODE_ENV unset)' },
  ];

  it.each(cases)('NODE_ENV=$NODE_ENV: development tools only in development, protections everywhere but development and test', (entry) => {
    const env = { NODE_ENV: entry.NODE_ENV };
    expect(environment.isDevelopment(env)).toBe(entry.development);
    expect(environment.isProtected(env)).toBe(entry.protected);
    expect(environment.app(env)).toBe(entry.app);
    expect(environment.describe(env)).toBe(entry.describe);
    expect(environment.isTest(env)).toBe(entry.NODE_ENV === 'test');
    expect(environment.problem(env)).toBeUndefined();
    expect(() => environment.check(env)).not.toThrow();
  });

  it('APP_ENV names the environment — and changes nothing else: APP_ENV=local on production is protected, no development', () => {
    expect(environment.describe({ NODE_ENV: 'production', APP_ENV: 'staging' })).toBe('production (APP_ENV=staging)');
    expect(environment.app({ NODE_ENV: 'production', APP_ENV: 'staging' })).toBe('staging');
    expect(environment.app({ NODE_ENV: 'development', APP_ENV: '' })).toBe('local'); // empty is missing
    for (const APP_ENV of ['local', 'development', 'testing', 'test']) {
      const env = { NODE_ENV: 'production', APP_ENV };
      expect(environment.isProtected(env), `APP_ENV=${APP_ENV} unprotected production`).toBe(true);
      expect(environment.isDevelopment(env), `APP_ENV=${APP_ENV} opened the development tools`).toBe(false);
    }
    // An APP_ENV given by the configuration (it may live in .env) wins over the one `env` has.
    expect(environment.describe({ NODE_ENV: 'production' }, 'staging')).toBe('production (APP_ENV=staging)');
  });

  it('any other NODE_ENV stops the start, with the hint to set NODE_ENV=production and APP_ENV=<name>', () => {
    expect(environment.problem({ NODE_ENV: 'staging' })).toBe(
      'NODE_ENV=staging is not an environment Node knows — set NODE_ENV=production and APP_ENV=staging. ' +
        'NODE_ENV is development, test or production; APP_ENV names the environment (docs/configuration.md#the-environment-node_env).',
    );
    expect(() => environment.check({ NODE_ENV: 'staging' })).toThrow(ConfigError);
    expect(() => environment.check({ NODE_ENV: 'staging' })).toThrow(
      /^Invalid environment — the application cannot start:\n {2}• NODE_ENV=staging is not an environment Node knows — set NODE_ENV=production and APP_ENV=staging\./,
    );
    expect(environment.problem({ NODE_ENV: 'Production' })).toBe('NODE_ENV=Production is not an environment Node knows — it is case-sensitive: set NODE_ENV=production.');
    expect(environment.problem({ NODE_ENV: 'qa-2' })).toMatch(/^NODE_ENV=qa-2 is not an environment Node knows — set NODE_ENV=production and APP_ENV=qa-2\./);
    // A value not worth repeating (a secret pasted into the wrong line, a sentence) is not echoed.
    expect(environment.problem({ NODE_ENV: 'sk_live_0123456789abcdef0123456789abcdef0123' })).toMatch(/^NODE_ENV is not an environment Node knows — set NODE_ENV=production, and name the environment in APP_ENV\./);
    expect(environment.problem({ NODE_ENV: 'stag ing' })).not.toContain('stag ing');
    // From .env: said so.
    expect(environment.problem({ NODE_ENV: 'staging', [DOTENV_MARKER]: 'staging' })).toMatch(/^NODE_ENV=staging \(in \.env\) is not an environment Node knows/);
    // The questions themselves stay fail-closed for a value no check stopped: protected, never development.
    expect(environment.isProtected({ NODE_ENV: 'staging' })).toBe(true);
    expect(environment.isDevelopment({ NODE_ENV: 'Development' })).toBe(false);
  });

  it('reads process.env when given nothing', () => {
    const before = { NODE_ENV: process.env.NODE_ENV, APP_ENV: process.env.APP_ENV };
    try {
      process.env.NODE_ENV = 'production';
      process.env.APP_ENV = 'staging';
      expect(environment.isProtected()).toBe(true);
      expect(environment.name()).toBe('production');
      expect(environment.app()).toBe('staging');
      delete process.env.NODE_ENV;
      delete process.env.APP_ENV;
      expect(environment.isProtected()).toBe(true);
      expect(environment.name()).toBeUndefined();
      expect(environment.app()).toBe('production');
    } finally {
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe('resolveEnvironment — where NODE_ENV comes from (E170)', () => {
  const app = (files: Record<string, string>) => {
    const root = tempDir('marmeon-env-');
    for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
    return root;
  };

  it('the process wins over .env — a stale mark from .env is dropped', () => {
    const root = app({ '.env': 'NODE_ENV=development\n' });
    const env: Record<string, string | undefined> = { NODE_ENV: 'production', [DOTENV_MARKER]: 'development' };
    expect(resolveEnvironment(root, { env })).toMatchObject({ name: 'production', source: 'process' });
    expect(env).toEqual({ NODE_ENV: 'production' });
    expect(environment.describe(env)).toBe('production (APP_ENV=production)');
  });

  it('takes .env when the process has none — marked, and named as such', () => {
    const env: Record<string, string | undefined> = {};
    expect(resolveEnvironment(app({ '.env': 'APP_NAME=x\nNODE_ENV=development\n' }), { env, fallback: 'production' })).toMatchObject({ name: 'development', source: '.env' });
    expect(env).toEqual({ NODE_ENV: 'development', [DOTENV_MARKER]: 'development' });
    expect(environment.describe(env)).toBe('development (APP_ENV=local, NODE_ENV from .env)');
    expect(environment.dotEnvDevelopmentWarning('start', env)).toMatch(/^NODE_ENV=development comes from \.env, not from the environment: marmeon start runs with the development tools/);
    // Resolving again (a re-executed child, createApplication after the CLI): still from .env.
    expect(resolveEnvironment(app({}), { env })).toMatchObject({ name: 'development', source: '.env' });
    const production: Record<string, string | undefined> = {};
    resolveEnvironment(app({ '.env': 'NODE_ENV=production\n' }), { env: production });
    expect(environment.describe(production)).toBe('production (APP_ENV=production, NODE_ENV from .env)');
    expect(environment.dotEnvDevelopmentWarning('start', production)).toBeUndefined();
    expect(environment.dotEnvDevelopmentWarning('start', { NODE_ENV: 'development' })).toBeUndefined(); // set in the process
  });

  it('stops at a NODE_ENV that is none of development, test, production — from the process or from .env (E217)', () => {
    const fromProcess: Record<string, string | undefined> = { NODE_ENV: 'staging' };
    expect(() => resolveEnvironment(app({}), { env: fromProcess, fallback: 'production' })).toThrow(/NODE_ENV=staging is not an environment Node knows — set NODE_ENV=production and APP_ENV=staging/);
    const fromDotEnv: Record<string, string | undefined> = {};
    expect(() => resolveEnvironment(app({ '.env': 'NODE_ENV=staging\n' }), { env: fromDotEnv })).toThrow(/NODE_ENV=staging \(in \.env\) is not an environment Node knows/);
  });

  it('takes APP_ENV as the configuration layers it — the process\'s, else .env.{NODE_ENV}\'s, else .env\'s — never a default', () => {
    const root = app({ '.env': 'NODE_ENV=production\nAPP_ENV=staging\n' });
    const env: Record<string, string | undefined> = {};
    resolveEnvironment(root, { env });
    expect(env.APP_ENV).toBe('staging');
    expect(environment.describe(env)).toBe('production (APP_ENV=staging, NODE_ENV from .env)');
    expect(loadEnv(root, undefined, {}).APP_ENV).toBe('staging');
    const overlaid: Record<string, string | undefined> = {};
    resolveEnvironment(app({ '.env': 'NODE_ENV=production\nAPP_ENV=staging\n', '.env.production': 'APP_ENV=eu-1\n' }), { env: overlaid });
    expect(overlaid.APP_ENV).toBe('eu-1');
    const own: Record<string, string | undefined> = { APP_ENV: 'review-42' };
    resolveEnvironment(root, { env: own });
    expect(own.APP_ENV).toBe('review-42');
    const none: Record<string, string | undefined> = {};
    resolveEnvironment(app({}), { env: none, fallback: 'production' });
    expect(none).toEqual({ NODE_ENV: 'production' });
  });

  it('ignores NODE_ENV in .env.{NODE_ENV} — with a warning, once', () => {
    const root = app({ '.env': 'NODE_ENV=production\n', '.env.production': 'NODE_ENV=development\nAPP_NAME=from-production\n' });
    const first = resolveEnvironment(root, { env: {} });
    expect(first.name).toBe('production');
    expect(first.warnings).toEqual(['NODE_ENV in .env.production is ignored: .env.production is chosen by NODE_ENV and cannot set it — set NODE_ENV in the environment or in .env.']);
    expect(resolveEnvironment(root, { env: {} }).warnings).toEqual([]);
    // The config side reads the same: .env picks .env.production, whose other variables apply, never its NODE_ENV.
    expect(loadEnv(root, undefined, {})).toMatchObject({ NODE_ENV: 'production', APP_NAME: 'from-production' });
    expect(loadEnv(root, undefined, { NODE_ENV: 'test' }).NODE_ENV).toBe('test');
  });

  it('missing everywhere: the command\'s fallback (start: production), else unset — production, protected', () => {
    const fallback: Record<string, string | undefined> = {};
    expect(resolveEnvironment(app({}), { env: fallback, fallback: 'production' })).toMatchObject({ name: 'production', source: 'fallback' });
    const unset: Record<string, string | undefined> = { NODE_ENV: '' };
    expect(resolveEnvironment(app({ '.env': 'NODE_ENV=\n' }), { env: unset })).toMatchObject({ name: undefined, source: 'unset' });
    expect(environment.isProtected(unset)).toBe(true);
    expect(environment.describe(unset)).toBe('production (APP_ENV=production, NODE_ENV unset)');
  });
});

describe('buildEnvironment — what marmeon build bakes into the browser code (W10 step 9b)', () => {
  const app = (files: Record<string, string>) => {
    const root = tempDir('marmeon-env-');
    for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
    return root;
  };

  it('a NODE_ENV=development of .env is set aside: the build runs as production (pnpm build on a developer\'s machine)', () => {
    const env: Record<string, string | undefined> = {};
    resolveEnvironment(app({ '.env': 'APP_NAME=x\nNODE_ENV=development\n' }), { env });
    expect(env.NODE_ENV).toBe('development');
    const { notes, warnings } = buildEnvironment(env);
    // Set, not removed: Vite reads the .env files itself and takes their NODE_ENV=development whenever the process has none.
    expect(env.NODE_ENV, 'the development NODE_ENV of .env reached the build').toBe('production');
    expect(env[DOTENV_MARKER]).toBeUndefined();
    expect(notes).toEqual(['NODE_ENV=development of .env is for the commands of this machine — marmeon build builds for production.']);
    expect(warnings).toEqual([]);
  });

  it('a NODE_ENV=development the environment sets is respected — with the warning; test builds for production', () => {
    const env: Record<string, string | undefined> = { NODE_ENV: 'development' };
    resolveEnvironment(app({ '.env': 'NODE_ENV=development\n' }), { env });
    const { warnings } = buildEnvironment(env);
    expect(env.NODE_ENV, 'an explicit NODE_ENV=development was overridden').toBe('development');
    expect(warnings[0]).toMatch(/^marmeon build with NODE_ENV=development: the browser code keeps its development branches/);
    const test: Record<string, string | undefined> = { NODE_ENV: 'test' };
    expect(buildEnvironment(test)).toEqual({ notes: ['marmeon build with NODE_ENV=test builds for production — the tests run the app without a build.'], warnings: [] });
    expect(test.NODE_ENV, 'NODE_ENV=test reached the build').toBe('production');
    const production: Record<string, string | undefined> = { NODE_ENV: 'production' };
    expect(buildEnvironment(production)).toEqual({ notes: [], warnings: [] });
    expect(production.NODE_ENV).toBe('production');
    const none: Record<string, string | undefined> = {};
    expect(buildEnvironment(none)).toEqual({ notes: [], warnings: [] });
    expect(none.NODE_ENV, 'a build without NODE_ENV is no production build').toBe('production');
  });

  it('any other NODE_ENV builds nothing (E217): the start error', () => {
    expect(() => buildEnvironment({ NODE_ENV: 'staging' })).toThrow(/NODE_ENV=staging is not an environment Node knows — set NODE_ENV=production and APP_ENV=staging/);
  });
});

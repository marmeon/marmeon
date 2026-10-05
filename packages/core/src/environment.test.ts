import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadEnv } from './config/config.ts';
import { DOTENV_MARKER, environment, resolveEnvironment } from './environment.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

describe('environment (E115, E139)', () => {
  const cases = [
    { NODE_ENV: 'development', development: true, protected: false, describe: 'development' },
    { NODE_ENV: 'test', development: false, protected: false, describe: 'test' },
    { NODE_ENV: 'production', development: false, protected: true, describe: 'production (protected)' },
    { NODE_ENV: 'staging', development: false, protected: true, describe: 'staging (protected)' },
    { NODE_ENV: 'Development', development: false, protected: true, describe: 'Development (protected)' },
    { NODE_ENV: undefined, development: false, protected: true, describe: 'unset NODE_ENV (protected, like production)' },
    { NODE_ENV: '', development: false, protected: true, describe: 'unset NODE_ENV (protected, like production)' },
  ];

  it.each(cases)('NODE_ENV=$NODE_ENV: development tools only in development, protections everywhere but development and test', (entry) => {
    const env = { NODE_ENV: entry.NODE_ENV };
    expect(environment.isDevelopment(env)).toBe(entry.development);
    expect(environment.isProtected(env)).toBe(entry.protected);
    expect(environment.describe(env)).toBe(entry.describe);
    expect(environment.isTest(env)).toBe(entry.NODE_ENV === 'test');
  });

  it('reads process.env when given nothing', () => {
    const before = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'staging';
      expect(environment.isProtected()).toBe(true);
      expect(environment.name()).toBe('staging');
      delete process.env.NODE_ENV;
      expect(environment.isProtected()).toBe(true);
      expect(environment.name()).toBeUndefined();
    } finally {
      if (before === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = before;
    }
  });
});

describe('resolveEnvironment — where NODE_ENV comes from (E170)', () => {
  const app = (files: Record<string, string>) => {
    const root = tempDir('bespoke-env-');
    for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
    return root;
  };

  it('the process wins over .env — a stale mark from .env is dropped', () => {
    const root = app({ '.env': 'NODE_ENV=development\n' });
    const env: Record<string, string | undefined> = { NODE_ENV: 'staging', [DOTENV_MARKER]: 'development' };
    expect(resolveEnvironment(root, { env })).toMatchObject({ name: 'staging', source: 'process' });
    expect(env).toEqual({ NODE_ENV: 'staging' });
    expect(environment.describe(env)).toBe('staging (protected)');
  });

  it('takes .env when the process has none — marked, and named as such', () => {
    const env: Record<string, string | undefined> = {};
    expect(resolveEnvironment(app({ '.env': 'APP_NAME=x\nNODE_ENV=development\n' }), { env, fallback: 'production' })).toMatchObject({ name: 'development', source: '.env' });
    expect(env).toEqual({ NODE_ENV: 'development', [DOTENV_MARKER]: 'development' });
    expect(environment.describe(env)).toBe('development (from .env)');
    expect(environment.dotEnvDevelopmentWarning('start', env)).toMatch(/^NODE_ENV=development comes from \.env, not from the environment: bespoke start runs with the development tools/);
    // Resolving again (a re-executed child, createApplication after the CLI): still from .env.
    expect(resolveEnvironment(app({}), { env })).toMatchObject({ name: 'development', source: '.env' });
    const staging: Record<string, string | undefined> = {};
    resolveEnvironment(app({ '.env': 'NODE_ENV=staging\n' }), { env: staging });
    expect(environment.describe(staging)).toBe('staging (protected, from .env)');
    expect(environment.dotEnvDevelopmentWarning('start', staging)).toBeUndefined();
    expect(environment.dotEnvDevelopmentWarning('start', { NODE_ENV: 'development' })).toBeUndefined(); // set in the process
  });

  it('ignores NODE_ENV in .env.{NODE_ENV} — with a warning, once', () => {
    const root = app({ '.env': 'NODE_ENV=staging\n', '.env.staging': 'NODE_ENV=development\nAPP_NAME=from-staging\n' });
    const first = resolveEnvironment(root, { env: {} });
    expect(first.name).toBe('staging');
    expect(first.warnings).toEqual(['NODE_ENV in .env.staging is ignored: .env.staging is chosen by NODE_ENV and cannot set it — set NODE_ENV in the environment or in .env.']);
    expect(resolveEnvironment(root, { env: {} }).warnings).toEqual([]);
    // The config side reads the same: .env picks .env.staging, whose other variables apply, never its NODE_ENV.
    expect(loadEnv(root, undefined, {})).toMatchObject({ NODE_ENV: 'staging', APP_NAME: 'from-staging' });
    expect(loadEnv(root, undefined, { NODE_ENV: 'test' }).NODE_ENV).toBe('test');
  });

  it('missing everywhere: the command\'s fallback (start: production), else unset — protected', () => {
    const fallback: Record<string, string | undefined> = {};
    expect(resolveEnvironment(app({}), { env: fallback, fallback: 'production' })).toMatchObject({ name: 'production', source: 'fallback' });
    const unset: Record<string, string | undefined> = { NODE_ENV: '' };
    expect(resolveEnvironment(app({ '.env': 'NODE_ENV=\n' }), { env: unset })).toMatchObject({ name: undefined, source: 'unset' });
    expect(environment.isProtected(unset)).toBe(true);
    expect(environment.describe(unset)).toBe('unset NODE_ENV (protected, like production)');
  });
});

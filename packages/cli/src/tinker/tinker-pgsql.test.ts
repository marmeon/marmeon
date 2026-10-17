import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { marmeon, session } from '../__fixtures__/tinker.ts';

const PGSQL_URL = process.env.MARMEON_TEST_PGSQL_URL;

describe.runIf(PGSQL_URL)('marmeon tinker --sandbox on Postgres', { timeout: 60_000 }, () => {
  const database = 'marmeon_tinker_test';
  const url = new URL(PGSQL_URL ?? 'postgres://localhost');
  // The server's own database is no database of the app (its migrations never ran there): reading it as another tool's keeps tinker from refusing it.
  const admin = { DB_CONNECTION: 'pgsql', DB_URL: url.href, DB_MANAGED: 'false' };
  const env = { DB_CONNECTION: 'pgsql', DB_URL: Object.assign(new URL(url.href), { pathname: `/${database}` }).href };
  const recreate = `const { sql } = await import('@marmeon/database'); await sql.raw('drop database if exists ${database}').execute(db);`;

  beforeAll(() => {
    expect(marmeon(['tinker', '-e', `${recreate} await sql.raw('create database ${database}').execute(db)`], admin).code).toBe(0);
    const fresh = marmeon(['migrate:fresh', '--seed', '--no-types'], env);
    expect(fresh.code, fresh.stderr).toBe(0);
  });
  afterAll(() => marmeon(['tinker', '-e', recreate], admin));

  it('rolls back, and a failed statement takes back only its own input', async () => {
    const before = Number(marmeon(['tinker', '-e', 'await repos.users.count()'], env).stdout);
    const insert = `await repos.users.insert({ name: 'Tinker', email: 'tinker@example.com', password: 'x', locale: 'en' })`;
    const { stdout } = await session(['--sandbox', '--no-history'], env, [`${insert}; 'first'`, `${insert}; 'twice'`, '`users:${await repos.users.count()}`', '.exit', ''].join('\n'));
    expect(stdout).toContain("'first'");
    expect(stdout).toMatch(/Uncaught:?\s+error: duplicate key value violates unique constraint "users_email_unique"/);
    // On Postgres a failed statement aborts the whole transaction — the input's savepoint keeps the session usable.
    expect(stdout).toContain(`'users:${before + 1}'`);
    expect(stdout).toContain(`db pgsql (${url.host}/${database})`);
    expect(stdout).not.toContain(url.password || 'never');
    expect(Number(marmeon(['tinker', '-e', 'await repos.users.count()'], env).stdout)).toBe(before);
  });
});

import { describe, expect, it } from 'vitest';
import { ConfigError, env, resolveConfig } from '@marmeon/core';
import { DatabaseConfig, defineConnection, describeConnection } from './config.ts';

describe('describeConnection: a password with @ or /', () => {
  it.each([
    ['postgres://app:p@ss/w0rd@db/shop', 'pgsql postgres://app:***@db/shop'],
    ['postgres://app:pa/ss@db:5433/shop', 'pgsql (invalid URL)'],
    ['postgres://app:p%40ss%2Fw0rd@db/shop', 'pgsql postgres://app:***@db/shop'],
    ['postgres://app:a@b@c@[::1]:5432/shop?password=x9&sslmode=require', 'pgsql postgres://app:***@[::1]:5432/shop?sslmode=require'],
    ['postgres://token_svc:pw@pass-db:5432/shop', 'pgsql postgres://token_svc:***@pass-db:5432/shop'],
    ['postgres://:p@ss@db/shop', 'pgsql postgres://:***@db/shop'],
  ])('masks the password of %s whole', (url, expected) => {
    expect(describeConnection({ driver: 'pgsql', url })).toBe(expected);
  });
});

describe('describeConnection', () => {
  it('shows host, port, database and user, masks the password and shows only the harmless parameters of the query string', () => {
    const text = describeConnection({ driver: 'pgsql', url: 'postgres://app:p4ss@db.internal:5433/shop?password=x9&sslmode=require&sslkey=/keys/a.pem#frag' });
    expect(text).toBe('pgsql postgres://app:***@db.internal:5433/shop?sslmode=require');
    expect(text).not.toMatch(/p4ss|x9|keys/);
  });

  it('keeps the parameters that say where the server is, so a socket connection stays readable', () => {
    const text = describeConnection({ driver: 'pgsql', url: 'postgres://app:p4ss@localhost/shop?host=/var/run/postgresql&sslmode=require&application_name=web&sslpassword=zz&options=-c%20x' });
    expect(text).toContain('host=%2Fvar%2Frun%2Fpostgresql');
    expect(text).toContain('sslmode=require');
    expect(text).toContain('application_name=web');
    expect(text).not.toMatch(/p4ss|zz|options/);
  });

  it('compares the parameter names exactly, like pg does: Host is no host', () => {
    expect(describeConnection({ driver: 'pgsql', url: 'postgres://app@db/shop?Host=x&SSLMODE=require&sslmode=require' })).toBe('pgsql postgres://app@db/shop?sslmode=require');
  });

  it('describes a URL without a password and a SQLite file as they are', () => {
    expect(describeConnection({ driver: 'pgsql', url: 'postgres://app@db/shop' })).toBe('pgsql postgres://app@db/shop');
    expect(describeConnection({ driver: 'sqlite', database: 'storage/app.db' })).toBe('sqlite storage/app.db');
  });
});

describe('DatabaseConfig: DB_DRIVER', () => {
  const resolve = (env: Record<string, string>) => resolveConfig([DatabaseConfig], env);

  it('selects the driver by its name', async () => {
    const resolved = await resolve({ DB_DRIVER: 'pgsql', DB_URL: 'postgres://app:pw@db/shop' });
    expect(resolved.get(DatabaseConfig)).toMatchObject({ default: { driver: 'pgsql' } });
  });

  it('stops the start when DB_CONNECTION is set, instead of starting on SQLite', async () => {
    const error = await resolve({ DB_CONNECTION: 'pgsql' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toContain('DB_CONNECTION was renamed DB_DRIVER');
  });
});

describe('DatabaseConfig: the Postgres database has no default name', () => {
  const resolve = (env: Record<string, string>) => resolveConfig([DatabaseConfig], { DB_DRIVER: 'pgsql', ...env });
  const message = async (env: Record<string, string>) => {
    const error = await resolve(env).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).message;
  };

  it('stops the start with neither DB_URL nor DB_DATABASE, and never picks "marmeon"', async () => {
    expect(await message({})).toContain('DB_DATABASE — set DB_DATABASE, or DB_URL with the database\'s name in its path');
    expect(await message({ DB_HOST: 'db.internal', DB_USERNAME: 'app' })).toContain('docs/database.md#configuration');
    expect(await message({ DB_DATABASE: '' })).toContain('K6');
  });

  it('refuses a DB_URL without the database in its path, which pg would fill from PGDATABASE or the user name', async () => {
    for (const DB_URL of ['postgres://app:pw@db:5432', 'postgres://app:pw@db/', 'postgres://app:pw@db:5432/?sslmode=require']) {
      const text = await message({ DB_URL, DB_DATABASE: 'shop' });
      expect(text).toContain('DB_URL with the database\'s name in its path');
      expect(text).not.toContain('pw@');
    }
  });

  it('refuses a named connection without a database name, as an empty one or a URL without a path', () => {
    const connection = (e: { database?: string; url?: string }) => defineConnection('reporting', { env: env({}), resolve: () => ({ driver: 'pgsql', ...e }) }).resolve({});
    expect(() => connection({ database: '' })).toThrow('The Postgres connection "reporting" needs a url or a database.');
    expect(() => connection({ url: 'postgres://app:pw@db:5432' })).toThrow("needs a database: the name in its url's path, or database.");
    expect(() => connection({ url: 'postgres://app:pw@db/' })).toThrow("needs a database: the name in its url's path, or database.");
    expect(connection({ url: 'postgres://app@db/shop' })).toMatchObject({ url: 'postgres://app@db/shop' });
  });

  it('takes the name from DB_DATABASE alone or from DB_URL alone', async () => {
    expect((await resolve({ DB_DATABASE: 'notes' })).get(DatabaseConfig)).toMatchObject({ default: { url: 'postgres://postgres@127.0.0.1:5432/notes' } });
    expect((await resolve({ DB_URL: 'postgres://app:pw@db/shop' })).get(DatabaseConfig)).toMatchObject({ default: { url: 'postgres://app:pw@db/shop' } });
  });

  it('leaves SQLite its file, with no name asked for', async () => {
    expect((await resolveConfig([DatabaseConfig], {})).get(DatabaseConfig)).toMatchObject({ default: { driver: 'sqlite', database: 'storage/database.sqlite' } });
  });
});

import { describe, expect, it } from 'vitest';
import { describeConnection } from './config.ts';

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

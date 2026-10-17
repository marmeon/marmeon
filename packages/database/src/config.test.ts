import { describe, expect, it } from 'vitest';
import { describeConnection } from './config.ts';

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

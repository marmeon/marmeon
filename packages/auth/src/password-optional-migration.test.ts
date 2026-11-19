import { copyFileSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Application, ModuleDefinition } from '@marmeon/core';
import { Migrator, sql } from '@marmeon/database';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { kinds, open } from './__fixtures__/schema-compare.ts';

// The starter kit's migration that lets `users.password` hold NULL, on a database that already has accounts: SQLite cannot change the
// column in place, so the migration makes it again and copies the hashes — the one step that can lose credentials.

const repo = new URL('../../../', import.meta.url);
const AUTH = new URL('../stubs/react/modules/auth/migrations/', import.meta.url);
const OPTIONAL = 'make_users_password_optional';
const isOptional = (file: string) => file.includes(OPTIONAL);

describe('the migration that makes users.password optional', () => {
  it('is the same file in the kit and in the web app, whatever its name', () => {
    const [template] = readdirSync(AUTH).filter(isOptional);
    const webMigrations = new URL('apps/web-app/modules/auth/migrations/', repo);
    const copies = readdirSync(webMigrations).filter(isOptional);
    expect(copies).toHaveLength(1);
    expect(readFileSync(new URL(copies[0]!, webMigrations), 'utf8')).toBe(readFileSync(new URL(template!, AUTH), 'utf8'));
  });

  describe.each(kinds)('on %s', { timeout: 30_000 }, (kind) => {
    it('keeps the hash of every account, lets the column take NULL, and keeps it secret', async () => {
      const root = realpathSync(tempDir('marmeon-password-optional-'));
      // The copies import the packages of the framework, as they do in an app.
      symlinkSync(fileURLToPath(new URL('apps/web-app/node_modules', repo)), join(root, 'node_modules'), 'dir');
      const directory = join(root, 'modules/auth/migrations');
      mkdirSync(directory, { recursive: true });
      for (const file of readdirSync(AUTH).filter((name) => name.endsWith('.ts') && !isOptional(name))) copyFileSync(new URL(file, AUTH), join(directory, file));
      const app = { root, modules: [{ name: 'auth', migrations: directory }] as ModuleDefinition[], container: { has: () => false, make: () => ({}) } } as unknown as Application;
      const { connections, drop } = await open(kind, true);
      try {
        await new Migrator(app, connections).migrate();
        const db = connections.get<any>();
        const now = new Date().toISOString();
        const hashes = { 'ada@example.com': 'hash-of-ada', 'alan@example.com': 'a different hash of alan' };
        for (const [email, hash] of Object.entries(hashes)) {
          await sql`insert into users (name, email, password, created_at, updated_at) values (${email}, ${email}, ${hash}, ${now}, ${now})`.execute(db);
        }

        for (const file of readdirSync(AUTH).filter(isOptional)) copyFileSync(new URL(file, AUTH), join(directory, file));
        await new Migrator(app, connections).migrate();

        // Read as raw SQL: no secret mark applies to it, so the stored values are what is compared.
        const { rows } = await sql<{ email: string; password: string | null }>`select email, password from users order by email`.execute(db);
        expect(Object.fromEntries(rows.map((row) => [row.email, row.password]))).toEqual(hashes);
        // A NULL password is stored, and read back as NULL.
        await sql`insert into users (name, email, password, created_at, updated_at) values ('Grace', 'grace@example.com', null, ${now}, ${now})`.execute(db);
        const grace = await sql<{ password: string | null }>`select password from users where email = 'grace@example.com'`.execute(db);
        expect(grace.rows[0]!.password).toBeNull();
        // The column is secret still: select-all has no hash.
        for (const row of await db.selectFrom('users').selectAll().execute()) expect(row).not.toHaveProperty('password');
      } finally {
        await drop();
      }
    });
  });
});

import { copyFileSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Application, ModuleDefinition } from '@marmeon/core';
import { Migrator, TypeGenerator, type Connections, type ProjectedTable } from '@marmeon/database';
import { projectApp } from '@marmeon/database/internal';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { describeTable, kinds, open } from './__fixtures__/schema-compare.ts';

// The framework's tables as a new app gets them (the starter's auth migrations, and the migration of each `make:*-table` command) against
// the tables of `apps/web-app`, which came from the first stubs and a series of upgrades. A table that differs is a finding, not a reason to
// compare less.

const repo = new URL('../../../', import.meta.url);
/** The migrations of the starter kit, which `make:auth` copies into `modules/auth`. */
const AUTH = new URL('../stubs/react/modules/auth/migrations/', import.meta.url);
/**
 * The file each `make:*-table` command copies into `modules/system`, found in the stubs of its package (these packages are no dependency of
 * this one). Each package ships exactly one.
 */
const SYSTEM = ['cache', 'session', 'queue', 'notifications', 'storage'].map((name) => {
  const directory = new URL(`../../${name}/stubs/migrations/`, import.meta.url);
  const files = readdirSync(directory).filter((file) => file.endsWith('.ts'));
  if (files.length !== 1) throw new Error(`${name} ships ${files.length} migrations in stubs/migrations, the test expects one.`);
  return new URL(files[0]!, directory);
});

/** What the migrations of the `make:*-table` commands ask of the configuration to pick their connection: everything on `default`. */
const defaultConnections = { driver: 'memory', connection: 'default', connections: {}, failed: { driver: 'memory' } };

const appOf = (root: string, directories: { auth: string; system: string }): Application =>
  ({
    root,
    modules: [{ name: 'auth', migrations: directories.auth }, { name: 'system', migrations: directories.system }] as ModuleDefinition[],
    container: { has: () => false, make: () => defaultConnections },
  }) as unknown as Application;

/** The web app, read from where it lies in the repository. Its projection is written to a directory of its own. */
function webApp(): Application {
  return appOf(tempDir('marmeon-framework-tables-'), { auth: fileURLToPath(new URL('apps/web-app/modules/auth/migrations', repo)), system: fileURLToPath(new URL('apps/web-app/modules/system/migrations', repo)) });
}

/** A new app: the migrations of the kit in `modules/auth`, one file per command in `modules/system`, each with a timestamp as `publish` names it. */
function newApp(): Application {
  const root = realpathSync(tempDir('marmeon-framework-tables-'));
  // The copies import the packages of the framework, as they do in an app.
  symlinkSync(fileURLToPath(new URL('apps/web-app/node_modules', repo)), join(root, 'node_modules'), 'dir');
  const auth = join(root, 'modules/auth/migrations');
  const system = join(root, 'modules/system/migrations');
  mkdirSync(auth, { recursive: true });
  mkdirSync(system, { recursive: true });
  for (const file of readdirSync(AUTH).filter((name) => name.endsWith('.ts'))) copyFileSync(new URL(file, AUTH), join(auth, file));
  SYSTEM.forEach((url, i) => copyFileSync(url, join(system, /^\d{4}_\d{2}_\d{2}_\d{6}_/.test(basename(url.pathname)) ? basename(url.pathname) : `2026_01_01_${String(i).padStart(6, '0')}_${basename(url.pathname)}`)));
  return appOf(root, { auth, system });
}

const byName = <T extends { name: string }>(entries: readonly T[]): T[] => [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

/**
 * The tables of the projection. Columns and indexes are sorted by name: an upgrade that makes a column again (the remember-me selector of
 * `sign_ins`, as a secret) puts it last, and a table is the same whatever the order of its columns.
 */
async function tablesOf(app: Application): Promise<Record<string, ProjectedTable>> {
  await projectApp(app);
  const { tables } = JSON.parse(readFileSync(join(app.root, '.marmeon/schema.json'), 'utf8')) as { tables: Record<string, ProjectedTable> };
  return Object.fromEntries(Object.entries(tables).map(([name, table]) => [name, { ...table, columns: byName(table.columns), indexes: byName(table.indexes) }]));
}

/** The text of each entry of an interface in the generated declaration, by the name it declares. */
function entriesOf(source: string, name: string): Map<string, string> {
  const lines = source.split('\n');
  const start = lines.indexOf(`  interface ${name} {`);
  const entries = new Map<string, string>();
  if (start < 0) return entries;
  let current: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line === '  }') break;
    current.push(line);
    if (line === '    };') {
      const key = current.find((text) => /^ {4}\S.*: \{$/.test(text))!;
      // Columns in the same order, for the reason given at `tablesOf`.
      const columns = current.filter((text) => /^ {6}\S/.test(text)).sort();
      entries.set(key.trim().replace(/: \{$/, ''), [...current.filter((text) => !/^ {6}\S/.test(text)).slice(0, -1), ...columns, '    };'].join('\n'));
      current = [];
    }
  }
  return entries;
}

async function declarationsOf(app: Application, driver: 'sqlite' | 'pgsql') {
  const connections = { options: () => ({ driver }) } as unknown as Connections;
  const { source } = await new TypeGenerator(app, connections, new Migrator(app, connections)).render();
  return { tables: entriesOf(source, 'Tables'), relations: entriesOf(source, 'Relations') };
}

/** What `users` is in a new app: the web app has columns of its own (`avatar_path`) besides these. */
const OWN_TO_WEB_APP = ['users'];

describe('the framework tables of a new app and of the web app', () => {
  it('have the same columns, indexes, keys and secret marks in the projection', async () => {
    const [web, fresh] = [await tablesOf(webApp()), await tablesOf(newApp())];
    expect(Object.keys(fresh)).toEqual(expect.arrayContaining(['users', 'email_changes', 'sign_ins', 'passkeys', 'personal_access_tokens', 'cache', 'sessions', 'jobs', 'notifications', 'temporary_uploads']));
    expect(Object.keys(fresh), 'remember_tokens is in neither').not.toContain('remember_tokens');
    expect(Object.keys(web)).not.toContain('remember_tokens');
    for (const [name, table] of Object.entries(fresh)) {
      expect(web[name], `${name} is in the web app`).toBeDefined();
      if (OWN_TO_WEB_APP.includes(name)) {
        for (const column of table.columns) expect(web[name]!.columns.find((candidate) => candidate.name === column.name), `${name}.${column.name}`).toEqual(column);
        expect(web[name]!.columns.map((column) => column.name)).toEqual(expect.arrayContaining(['locale', 'avatar_path']));
        continue;
      }
      expect(web[name], name).toEqual(table);
    }
  });

  it('are declared by the same text in database.d.ts, table by table and relation by relation', async () => {
    const [web, fresh] = [await declarationsOf(webApp(), 'sqlite'), await declarationsOf(newApp(), 'sqlite')];
    expect(fresh.tables.size).toBeGreaterThan(10);
    for (const [name, text] of fresh.tables) {
      if (OWN_TO_WEB_APP.includes(name)) continue;
      expect(web.tables.get(name), name).toBe(text);
    }
    expect([...fresh.relations.keys()]).toEqual(expect.arrayContaining(['users', 'sign_ins']));
    for (const [name, text] of fresh.relations) expect(web.relations.get(name), `relations of ${name}`).toBe(text);
  });

  describe.each(kinds)('in the database on %s', (kind) => {
    it('are the same tables, with the same columns, indexes and constraints', async () => {
      const [webApplication, freshApplication] = [webApp(), newApp()];
      const [web, fresh] = [await open(kind, true), await open(kind, true)];
      try {
        await new Migrator(webApplication, web.connections).migrate();
        await new Migrator(freshApplication, fresh.connections).migrate();
        const tableNames = async (connections: Connections) => (await connections.get<any>().introspection.getTables()).map((table: { name: string }) => table.name).filter((name: string) => name !== 'migrations');
        const names = await tableNames(fresh.connections);
        expect(names).toEqual(expect.arrayContaining(['users', 'email_changes', 'sign_ins', 'sessions', 'temporary_uploads']));
        expect(names, 'remember_tokens is in neither').not.toContain('remember_tokens');
        expect(await tableNames(web.connections)).not.toContain('remember_tokens');
        for (const name of names) {
          const [ours, theirs] = [await describeTable(fresh.connections, name), await describeTable(web.connections, name)];
          if (OWN_TO_WEB_APP.includes(name)) {
            // Every column of the new app is in the web app, which has its own besides.
            for (const column of ours.columns) expect(theirs.columns, `${name}: ${column}`).toContain(column);
            continue;
          }
          expect(theirs, name).toEqual(ours);
        }
      } finally {
        await fresh.drop();
        await web.drop();
      }
    });
  });
});

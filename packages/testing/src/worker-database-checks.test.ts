import type { Application } from '@marmeon/core';
import { requireDriver } from '@marmeon/database/internal';
import { describe, expect, it, vi } from 'vitest';
import { emptyWorkerDatabase, prepareWorkerDatabase, type WorkerDatabase } from './database.ts';

// Stubs instead of a server: no connection can be made to name the worker and still reach another database (a pooler could),
// and a refusal that comes before any connection is what these tests pin.

type Module = Parameters<typeof prepareWorkerDatabase>[0];
const appWith = (url: string): Application => {
  class Connections {
    options() {
      return { driver: 'pgsql', url };
    }
  }
  return { container: { make: () => new Connections() } } as unknown as Application;
};

describe('emptyWorkerDatabase() on Postgres', () => {
  const worker: WorkerDatabase = { key: 'postgres://u:p@localhost:5432/app_test_x_1_2', env: {} };

  it('refuses when the server answers with another database than the worker’s, before anything is read or written', async () => {
    const executed: string[] = [];
    const sql = Object.assign(
      (strings: TemplateStringsArray) => ({
        execute: async () => {
          executed.push(strings.join('?'));
          return { rows: [{ name: 'app' }] };
        },
      }),
      { raw: () => ({ execute: async () => (executed.push('raw'), { rows: [] }) }) },
    );
    const tableColumns = vi.fn();
    class Connections {
      options() {
        return { driver: 'pgsql', url: worker.key };
      }
      get() {
        return {};
      }
    }
    const app = { container: { make: () => new Connections() } } as unknown as Application;
    const database = { Connections, sql, isMigratorTable: () => false, tableColumns, requireDriver } as never;
    await expect(emptyWorkerDatabase(database, app, worker)).rejects.toThrow('the server answers for another one');
    expect(executed).toEqual(['select current_database() as name']);
    expect(tableColumns).not.toHaveBeenCalled();
  });
});

describe('emptyWorkerDatabase() on a driver it has no SQL for', () => {
  it('refuses with D29 before the connection is asked for a statement', async () => {
    const executed: string[] = [];
    class Connections {
      options() {
        return { driver: 'mysql', url: 'mysql://x@127.0.0.1/db' } as never;
      }
      get(): never {
        executed.push('get');
        throw new Error('a connection must not be taken');
      }
    }
    const app = { container: { make: () => new Connections() } } as unknown as Application;
    const sql = Object.assign(() => ({ execute: async () => (executed.push('sql'), { rows: [] }) }), { raw: () => ({ execute: async () => (executed.push('raw'), { rows: [] }) }) });
    const database = { Connections, sql, isMigratorTable: () => false, tableColumns: vi.fn(), requireDriver } as never;
    await expect(emptyWorkerDatabase(database, app, { key: 'mysql://x@127.0.0.1/db', env: {} })).rejects.toThrow(/\[marmeon:D29\] A test app with a database needs a sqlite or pgsql connection, not "mysql"; point the default connection at one\./);
    expect(executed).toEqual([]);
  });
});

describe('preparing the worker’s Postgres database', () => {
  const database = { Connections: class {}, DatabaseConnectionError: class extends Error {} } as unknown as Module;
  const server = 'postgres://u:p@localhost:5432/';

  it.each([
    ['a name that is no worker database', `${server}app`, `${server}marmeon`],
    ['the configured database itself, even in the shape of a worker’s', `${server}app_test_x_1_2`, `${server}app_test_x_1_2`],
  ])('refuses to create %s — before any connection is made', async (_label, url, adminUrl) => {
    const worker: WorkerDatabase = { key: url, env: {}, adminUrl };
    await expect(prepareWorkerDatabase(database, appWith(url), worker)).rejects.toThrow('it is not a worker database');
  });
});

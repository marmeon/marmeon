import { tempDir } from '../../../scripts/test/temp-dir.js';
import { defineModule, type ApplicationDefinition } from '@marmeon/core';
import { Connections, DatabaseServiceProvider, inTransaction, type Generated } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { AfterResponse, Controller, HttpServiceProvider } from '@marmeon/http';
import { describe, expect, it } from 'vitest';
import { createTestApp } from './index.ts';
import { openRoutes } from './test-helpers/open-routes.ts';

// The HTTP kernel cuts the ambient transaction context at its own boundary: work after the response.

interface NotesTables {
  notes: { id: Generated<number>; title: string; pinned: Generated<boolean> };
}

/** Lets the test decide when the deferred work may run — after the transaction around the request has finished. */
const gate = { open: Promise.withResolvers<void>(), outcome: Promise.withResolvers<unknown>() };

class DeferInTransactionController extends Controller {
  readonly #connections: Connections;
  readonly #after: AfterResponse;
  constructor(connections: Connections, after: AfterResponse) {
    super();
    this.#connections = connections;
    this.#after = after;
  }
  async handle() {
    const db = this.#connections.get<NotesTables>();
    await this.#connections.transaction(async () => {
      await db.insertInto('notes').values({ title: 'in the request' }).execute();
      // Registered inside the transaction — runs after the response, on its own.
      this.#after.defer(async () => {
        await gate.open.promise;
        try {
          await db.insertInto('notes').values({ title: `deferred, in a transaction: ${inTransaction()}` }).execute();
          gate.outcome.resolve('written');
        } catch (error) {
          gate.outcome.resolve(error);
        }
      });
    });
    return Response.json({ ok: true });
  }
}

const PGSQL_URL = process.env.MARMEON_TEST_PGSQL_URL;
const drivers = PGSQL_URL ? (['sqlite', 'pgsql'] as const) : (['sqlite'] as const);

describe.each(drivers)('work after the response on %s', (driver) => {
  const env = { APP_KEY: generateKey(), ...(driver === 'pgsql' ? { DB_CONNECTION: 'pgsql', DB_URL: PGSQL_URL } : { DB_CONNECTION: 'sqlite', DB_URL: undefined, DB_DATABASE: ':memory:' }) };
  const definition: ApplicationDefinition = {
    root: tempDir('marmeon-testing-db-'),
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, DatabaseServiceProvider],
    modules: [
      defineModule({
        name: 'notes',
        migrations: new URL('./__fixtures__/migrations/', import.meta.url),
        routes: openRoutes((Route) => Route.get('/defer', DeferInTransactionController)),
      }),
    ],
  };

  it('runs outside of any transaction — also one that was open around the request and is finished by then', async () => {
    gate.open = Promise.withResolvers();
    gate.outcome = Promise.withResolvers();
    const app = await createTestApp(definition, { env, database: 'refresh' });
    const connections = app.make(Connections);
    // A request handled inside a transaction (in-process), which rolls back after the response.
    await connections
      .transaction(async () => {
        expect((await app.stream('/defer')).status).toBe(200);
        throw new Error('rolled back');
      })
      .catch(() => {});
    gate.open.resolve();
    expect(await gate.outcome.promise).toBe('written');
    await app.assertDatabaseHas<'notes', NotesTables>('notes', { title: 'deferred, in a transaction: false' });
    await app.assertDatabaseMissing<'notes', NotesTables>('notes', { title: 'in the request' });
  });
});

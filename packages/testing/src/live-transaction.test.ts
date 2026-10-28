import { defineModule, type ApplicationDefinition } from '@marmeon/core';
import { Connections, DatabaseServiceProvider, type Generated } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { Controller, HttpServiceProvider } from '@marmeon/http';
import { Broadcaster, LiveServiceProvider } from '@marmeon/live';
import { SessionServiceProvider } from '@marmeon/session';
import { afterEach, describe, expect, it } from 'vitest';
import { workspaceTempDir } from '../../../scripts/test/temp-dir.js';
import { createTestApp, type TestApp } from './index.ts';
import { openRoutes } from './test-helpers/open-routes.ts';

interface NotesTables {
  notes: { id: Generated<number>; title: string; pinned: Generated<boolean> };
}

/** Pins three notes in one transaction and hints the board once per row, as a bulk change that refreshes in a loop does. */
class PinNotesController extends Controller {
  readonly #connections: Connections;
  readonly #broadcast: Broadcaster;
  constructor(connections: Connections, broadcast: Broadcaster) {
    super();
    this.#connections = connections;
    this.#broadcast = broadcast;
  }
  async handle() {
    const db = this.#connections.get<NotesTables>();
    await this.#connections.transaction(async () => {
      for (const title of ['a', 'b', 'c']) {
        await db.insertInto('notes').values({ title, pinned: true }).execute();
        await this.#broadcast.refresh('board.1', { only: ['notes'] });
      }
    });
    return new Response(null, { status: 204 });
  }
}

const definition: ApplicationDefinition = {
  root: workspaceTempDir('marmeon-testing-live-transaction-'),
  discover: false,
  providers: [EncryptionServiceProvider, HttpServiceProvider, SessionServiceProvider, DatabaseServiceProvider, LiveServiceProvider],
  modules: [
    defineModule({
      name: 'notes',
      migrations: new URL('./__fixtures__/migrations/', import.meta.url),
      routes: openRoutes((Route) => Route.post('/notes/pin', PinNotesController)),
    }),
  ],
};
const env = { APP_KEY: generateKey(), SESSION_DRIVER: 'memory', DB_DRIVER: 'sqlite', DB_URL: undefined, DB_DATABASE: ':memory:' };

describe.each(['refresh', 'isolated'] as const)('a bulk change in one transaction, database: %s', (database) => {
  let app: TestApp | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('hints its channel once after the commit', async () => {
    app = await createTestApp(definition, { env, database });
    await app.post('/notes/pin').assertNoContent();
    app.broadcast.assertRefreshed('board.1', { only: ['notes'], times: 1 });
    expect(await app.make(Connections).get<NotesTables>().selectFrom('notes').select('id').execute()).toHaveLength(3);
  });
});

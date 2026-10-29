import { join } from 'node:path';
import { createApplication, defineModule } from '@marmeon/core';
import { Connections, DatabaseServiceProvider, sql } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { Controller, defineRequest, HttpServiceProvider, type HttpContext } from '@marmeon/http';
import { PageSession } from '@marmeon/http/internal';
import { PAGE_HEADER, PROTOCOL_VERSION, UPLOAD_HEADER } from '@marmeon/http/protocol';
import { defineRoutes, everyone, type RouteBinder } from '@marmeon/router';
import { createHttpKernel } from '@marmeon/server';
import { rules as r } from '@marmeon/validation';
import { afterAll, describe, expect, it } from 'vitest';
import { freshDirectory, removeDirectories } from './__fixtures__/disks.ts';
import { defineStorage } from './config.ts';
import { StorageServiceProvider, UPLOADS_TABLE, upload } from './index.ts';

afterAll(removeDirectories);

/** An event has the upload fields its record names — the form is built from the bound record. */
interface Event {
  fields: string[];
}

const log: string[] = [];

class Events implements RouteBinder<Event> {
  resolveRouteBinding(value: string) {
    return value === 'a' ? { fields: ['badge'] } : value === 'b' ? { fields: ['menu'] } : undefined;
  }
}

class Registration extends Controller {
  static request = defineRequest({
    schema: async (_resolve, ctx: HttpContext<{}, { event?: Event }>) => {
      log.push('schema');
      await Promise.resolve();
      return r.object(Object.fromEntries((ctx.params.event?.fields ?? []).map((field) => [field, upload({ maxBytes: 1000 })])));
    },
    authorize: (ctx: HttpContext<{}, { event?: Event }>) => ctx.request.headers.get('x-allowed') !== 'no',
  });
  handle() {
    return 'ok';
  }
}

async function boot() {
  const base = freshDirectory();
  const app = await createApplication({
    root: base,
    discover: false,
    config: [defineStorage({ default: 'uploads', disks: { uploads: { driver: 'local', root: join(base, 'uploads') } } })],
    providers: [EncryptionServiceProvider, DatabaseServiceProvider, HttpServiceProvider, StorageServiceProvider],
    modules: [
      defineModule({
        name: 'events',
        routes: defineRoutes((Route) => Route.authorize(everyone).bind('event', Events).post('/events/:event/register', Registration).name('events.register')),
      }),
    ],
  }, { env: { APP_KEY: generateKey(), LOG_LEVEL: 'silent', DB_MANAGED: 'false', DB_DRIVER: 'sqlite', DB_DATABASE: ':memory:', UPLOADS_CONNECTION: 'default' } });
  app.container.scoped(PageSession, () => ({ csrfToken: () => undefined, scope: () => 'a-session', generation: () => undefined }));
  await sql`
    create table ${sql.table(UPLOADS_TABLE)} (
      id varchar(36) primary key, session varchar(64) not null, route varchar(200) not null, field varchar(200) not null,
      disk varchar(100) not null, key varchar(255) not null, name varchar(255) not null, max_bytes bigint not null, size bigint,
      created_at bigint not null, expires_at bigint not null, started_at bigint, uploaded_at bigint, consumed_at bigint
    )
  `.execute(app.container.make(Connections).get('default'));
  const kernel = createHttpKernel(app);
  return (event: string, field: string, headers: Record<string, string> = {}) =>
    kernel.request(`/events/${event}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', [PAGE_HEADER]: PROTOCOL_VERSION, [UPLOAD_HEADER]: field, ...headers },
      body: JSON.stringify({ name: 'badge.png', size: 10 }),
    });
}

describe('an upload target of a form built per request', () => {
  it('is made for a field the bound record names — and only for that record’s fields', async () => {
    const target = await boot();
    log.length = 0;
    expect((await target('a', 'badge')).status).toBe(200);
    expect(log).toEqual(['schema']);
    expect((await target('a', 'menu')).status).toBe(404); // the field of another event
    expect((await target('b', 'menu')).status).toBe(200);
  });

  it('never builds the schema for a request that is refused', async () => {
    const target = await boot();
    log.length = 0;
    expect((await target('a', 'badge', { 'x-allowed': 'no' })).status).toBe(403);
    expect((await target('z', 'badge')).status).toBe(404); // the binder finds no event
    expect(log).toEqual([]);
  });
});

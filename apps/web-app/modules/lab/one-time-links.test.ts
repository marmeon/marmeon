import { Connections, Database, secret } from '@marmeon/database';
import { hashLinkToken } from '@marmeon/encryption';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { WARM_UP_TIMEOUT, warmUpDatabase } from '../auth/warm-up.ts';
import { OneTimeLinkRepository } from './OneTimeLinkRepository.ts';

beforeAll(warmUpDatabase, WARM_UP_TIMEOUT);

/** `/lab/one-time-links`: a link that is used once — the token in the path, only its hash in the table. */

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh', env: { LAB_PAGES: 'true' } });
});
afterEach(async () => {
  await app.close();
});

const json = { accept: 'application/json' };
const create = async () => {
  const response = await app.post('/lab/one-time-links', { json: {}, headers: json }).assertStatus(201);
  return ((await response.json()) as { path: string }).path;
};

describe('a link that is used once', () => {
  it('opens as often as it is fetched; only the POST uses it up', async () => {
    const path = await create();
    expect(path).toMatch(/^\/lab\/one-time-links\/[A-Za-z0-9_-]{43}$/);
    // A mail scanner or a preview fetches the link first: the GET must leave it intact.
    await app.get(path).assertOk();
    await app.get(path).assertOk();
    await app.post(path, { json: {}, headers: json }).assertOk();
    await app.get(path).assertNotFound();
    await app.post(path, { json: {}, headers: json }).assertNotFound();
  });

  it('sends the page and the answer that makes the link with headers that keep the path private', async () => {
    const made = await app.post('/lab/one-time-links', { json: {}, headers: json });
    const path = ((await made.json()) as { path: string }).path;
    const page = await app.get(path).assertOk();
    const used = await app.post(path, { json: {}, headers: json }).assertOk();
    for (const response of [made, page, used]) {
      expect(response.headers.get('cache-control')).toBe('no-store, private');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    }
  });

  it('keeps no token in the table — only the hash, which is no token', async () => {
    const token = (await create()).split('/').pop()!;
    const rows = await app.make(Database).selectFrom('lab_one_time_links').select([(eb) => secret(eb, 'token_hash')]).execute();
    expect(rows).toEqual([{ token_hash: hashLinkToken(token) }]);
    expect(rows[0]!.token_hash).not.toContain(token);
  });

  it('answers 404 for a wrong token, one of the wrong shape and the stored hash', async () => {
    const path = await create();
    const token = path.split('/').pop()!;
    const other = `${token.slice(0, 42)}${token.endsWith('A') ? 'B' : 'A'}`;
    await app.get(`/lab/one-time-links/${other}`).assertNotFound();
    await app.get(`/lab/one-time-links/${token.slice(1)}`).assertNotFound();
    await app.get(`/lab/one-time-links/${'x'.repeat(2000)}`).assertNotFound();
    await app.get(`/lab/one-time-links/${hashLinkToken(token)}`).assertNotFound();
    await app.post(`/lab/one-time-links/${other}`, { json: {}, headers: json }).assertNotFound();
    await app.get(path).assertOk();
  });

  it('is used up by one of two requests that arrive at once', async () => {
    const path = await create();
    const results = await Promise.all([app.post(path, { json: {}, headers: json }), app.post(path, { json: {}, headers: json })]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 404]);
  });

  it('redeems on a transaction through using() — a repository whose constructor takes more than the connections cannot', async () => {
    const links = app.make(OneTimeLinkRepository);
    const connections = app.make(Connections);
    const token = (await create()).split('/').pop()!;
    const row = (await links.resolveRouteBinding(token))!;
    expect(await connections.get<any>().transaction().execute((trx) => links.using(trx).redeem(row.id))).toBe(true);
    expect(await links.redeem(row.id)).toBe(false);
  });

  it('is a 404 while the lab is off', async () => {
    await app.close();
    app = await createTestApp(application, { database: 'refresh' });
    await app.post('/lab/one-time-links', { json: {}, headers: json }).assertNotFound();
  });
});

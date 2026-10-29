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
      expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    }
  });

  it('sends the same headers on the answers that refuse: a wrong token and a used link', async () => {
    const path = await create();
    const wrong = `/lab/one-time-links/${'A'.repeat(43)}`;
    await app.post(path, { json: {}, headers: json }).assertOk();
    const refused = [
      await app.get(wrong, { headers: { accept: 'text/html' } }).assertNotFound(),
      await app.get(wrong, { headers: json }).assertNotFound(),
      await app.post(wrong, { json: {}, headers: json }).assertNotFound(),
      await app.get(path, { headers: json }).assertNotFound(),
      await app.post(path, { json: {}, headers: json }).assertNotFound(),
    ];
    for (const response of refused) {
      expect(response.headers.get('cache-control')).toBe('no-store, private');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
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

  it('trades the token for session state in a new session id, and a failed form returns with its errors and input', async () => {
    const path = await create();
    const token = path.split('/').pop()!;
    // A stored session of the attacker's, planted in the visitor's browser: it already holds an invitation of the attacker's own link.
    const other = (await create()).split('/').pop()!;
    const planted = (await app.get(`/lab/invitations/${other}`, { headers: { accept: 'text/html' } })).cookie('marmeon_session')!;
    const claimed = await app.withCookie('marmeon_session', planted).get(`/lab/invitations/${token}`, { headers: { accept: 'text/html' } }).assertRedirect('/lab/invitation');
    expect(claimed.headers.get('referrer-policy')).toBe('no-referrer');
    // A new id after the trade: the planted one is gone, so whoever planted it reads nothing of the visitor's. The session keeps an id, never the token.
    expect(claimed.cookie('marmeon_session')).not.toBe(planted);
    await app.withCookie('marmeon_session', planted).get('/lab/invitation', { headers: json }).assertNotFound();
    claimed.assertSessionHas('lab.invitation');
    expect(JSON.stringify(claimed.session())).not.toContain(token);
    const session = claimed.cookie('marmeon_session')!;

    const form = await app.withCookie('marmeon_session', session).get('/lab/invitation', { headers: { accept: 'text/html' } }).assertOk();
    expect(form.headers.get('referrer-policy')).toBe('same-origin');
    expect(form.headers.get('cache-control')).toBe('no-store, private');
    expect(form.body).not.toContain(token);

    // The browser posts from the page (a Referer of this site) and the failure sends it back there: errors and old input flashed.
    const failed = await app
      .withCookie('marmeon_session', session)
      .post('/lab/invitation', { form: { name: 'x'.repeat(41) }, headers: { referer: 'http://localhost/lab/invitation' } })
      .assertRedirect('/lab/invitation');
    failed.assertInvalid(['name']);
    expect(JSON.stringify(failed.session())).toContain('x'.repeat(41));
    expect(failed.headers.get('referrer-policy')).toBe('same-origin');
    expect(JSON.stringify(failed.session())).not.toContain(token);
  });

  it('shows the form and takes it only for a session that holds an unused invitation, once', async () => {
    const token = (await create()).split('/').pop()!;
    const claim = async () => (await app.get(`/lab/invitations/${token}`, { headers: { accept: 'text/html' } }).assertRedirect('/lab/invitation')).cookie('marmeon_session')!;
    const [one, two] = [await claim(), await claim()];
    const as = (cookie: string) => app.withCookie('marmeon_session', cookie);

    await app.get('/lab/invitation', { headers: json }).assertNotFound();
    await app.post('/lab/invitation', { json: { name: 'Ada' }, headers: json }).assertNotFound();
    await app.post('/lab/invitation', { json: { name: '' }, headers: json }).assertNotFound();

    const used = await as(one).post('/lab/invitation', { json: { name: 'Ada' }, headers: json }).assertOk();
    used.assertSessionMissing('lab.invitation');
    // Used up: the session that used it, and the other that held the same invitation, are shut out.
    await as(one).get('/lab/invitation', { headers: json }).assertNotFound();
    await as(one).post('/lab/invitation', { json: { name: 'Ada' }, headers: json }).assertNotFound();
    await as(two).get('/lab/invitation', { headers: json }).assertNotFound();
    await as(two).post('/lab/invitation', { json: { name: 'Ada' }, headers: json }).assertNotFound();
  });
});

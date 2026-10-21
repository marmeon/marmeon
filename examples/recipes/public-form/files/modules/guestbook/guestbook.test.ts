import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import type { ListGuestbookEntriesController } from './controllers/ListGuestbookEntriesController.ts';
import { GuestbookRepository } from './GuestbookRepository.ts';

// What a guest may read and send, and what stops a script.

let app: TestApp;
// Every test boots the app on a refreshed database — seconds on a busy machine, so its hook and tests get 30 s.
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
}, 30_000);

const entries = () => app.make(GuestbookRepository);
const approved = () => new Date().toISOString();

describe('the guestbook', { timeout: 30_000 }, () => {
  it('shows a guest the approved entries and nothing else', async () => {
    await entries().insert({ name: 'Ada', message: 'Lovely page', approved_at: approved() });
    await entries().insert({ name: 'Spammer', message: 'Buy now', approved_at: null });

    await app.navigating().get('/guestbook').assertPage<ListGuestbookEntriesController>('guestbook/ListGuestbookEntries', (props) => {
      expect(props.entries.data.map((entry) => entry.name)).toEqual(['Ada']);
      expect(props.entries.data[0]).not.toHaveProperty('approved_at');
    });
  });

  it('saves what a guest sends as an entry nobody approved, and sends the guest back', async () => {
    await app.post('/guestbook', { form: { name: '  Ada ', message: 'Hello', approved_at: approved() } }).assertRedirect('/guestbook');
    expect(await entries().findBy('name', 'Ada')).toMatchObject({ message: 'Hello', approved_at: null });
    // The entry is not on the page until somebody approves it.
    await app.navigating().get('/guestbook').assertPage<ListGuestbookEntriesController>('guestbook/ListGuestbookEntries', (props) => {
      expect(props.entries.data).toEqual([]);
    });
  });

  it('refuses a missing or a too long name and message', async () => {
    await app.post('/guestbook', { form: { name: ' ', message: 'Hello' } }).assertRedirect().assertInvalid(['name']);
    await app.post('/guestbook', { form: { name: 'x'.repeat(61), message: 'Hello' } }).assertRedirect().assertInvalid(['name']);
    await app.post('/guestbook', { form: { name: 'Ada', message: '' } }).assertRedirect().assertInvalid(['message']);
    await app.post('/guestbook', { form: { name: 'Ada', message: 'x'.repeat(501) } }).assertRedirect().assertInvalid(['message']);
    expect(await entries().count()).toBe(0);
  });

  it('opens an approved entry to everyone and answers 404 for any other', async () => {
    const shown = await entries().insert({ name: 'Ada', message: 'Lovely page', approved_at: approved() });
    const hidden = await entries().insert({ name: 'Spammer', message: 'Buy now', approved_at: null });
    await app.navigating().get(`/guestbook/${shown.id}`).assertPage('guestbook/ShowGuestbookEntry', { entry: { id: shown.id, name: 'Ada', message: 'Lovely page', created_at: shown.created_at } });
    // An entry nobody approved answers like an id that does not exist.
    await app.get(`/guestbook/${hidden.id}`).assertNotFound();
    await app.get('/guestbook/c0a80101-0000-7000-8000-000000000000').assertNotFound();
    await app.get('/guestbook/no-such-id').assertNotFound();
  });

  it('answers the sixth entry of a minute from one client with 429', async () => {
    const send = () => app.post('/guestbook', { form: { name: 'Bot', message: 'Hello' } });
    for (let attempt = 1; attempt <= 5; attempt++) (await send()).assertRedirect('/guestbook');
    (await send()).assertStatus(429);
    expect(await entries().count()).toBe(5);
    // The next minute opens a new window.
    app.travel({ seconds: 61 });
    (await send()).assertRedirect('/guestbook');
  });

  it('answers the twenty-first entry of a day with 429, however slowly they came', async () => {
    const send = () => app.post('/guestbook', { form: { name: 'Bot', message: 'Hello' } });
    for (let attempt = 1; attempt <= 20; attempt++) {
      (await send()).assertRedirect('/guestbook');
      if (attempt % 5 === 0) app.travel({ seconds: 61 });
    }
    (await send()).assertStatus(429);
    expect(await entries().count()).toBe(20);
  });

  it('refuses a form sent from another site', async () => {
    await app.close(); // one database app per test
    const protectedApp = await createTestApp(application, { csrf: true, database: 'refresh' });
    const form = { name: 'Ada', message: 'Hello' };
    await protectedApp.post('/guestbook', { form, headers: { 'sec-fetch-site': 'cross-site' } }).assertStatus(403);
    await protectedApp.post('/guestbook', { form, headers: { origin: 'https://evil.example' } }).assertStatus(403);
    // Neither header, as a script sends it: a guest has no token, so the answer is 419.
    await protectedApp.post('/guestbook', { form }).assertStatus(419);
    await protectedApp.post('/guestbook', { form, headers: { 'sec-fetch-site': 'same-origin' } }).assertRedirect('/guestbook');
    expect(await protectedApp.make(GuestbookRepository).count()).toBe(1);
  });

  it('shows the markup of a message as text', async () => {
    await app.close(); // one database app per test
    const rendering = await createTestApp(application, { database: 'refresh', ssr: true });
    await rendering.make(GuestbookRepository).insert({ name: 'Mallory', message: '<script>alert(1)</script>', approved_at: approved() });
    await rendering
      .get('/guestbook', { headers: { accept: 'text/html' } })
      .assertOk()
      .assertServerRendered()
      .assertSee('&lt;script&gt;alert(1)&lt;/script&gt;')
      .assertDontSee('<script>alert(1)');
    await rendering.close();
  });
});

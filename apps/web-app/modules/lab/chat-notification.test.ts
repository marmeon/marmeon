import { createTestApp, type TestApp } from '@marmeon/testing';
import { afterEach, beforeAll, beforeEach, describe, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from '../auth/factories/UserFactory.ts';
import { WARM_UP_TIMEOUT, warmUpDatabase } from '../auth/warm-up.ts';
import type { SendChatLabController } from './controllers/ChatLabController.ts';
import { LabChatNotification } from './notifications.ts';

/** `/lab/chat`: a signed-in user sends a notification whose `chat` channel posts to the `ops` destination. */

beforeAll(warmUpDatabase, WARM_UP_TIMEOUT);

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh', env: { LAB_PAGES: 'true' } });
});
afterEach(async () => {
  await app.close();
});

const json = { accept: 'application/json' };

const FIRST_MESSAGE = '<!channel> @everyone';

describe('the chat notification', () => {
  it('shows the form to a signed-in user', async () => {
    const ada = await app.factory(UserFactory).create();
    await app.actingAs(ada).navigating().get('/lab/chat').assertOk().assertPage('lab/Chat', { unavailable: null });
  });

  it('sends the notification, queues the text as typed for the ops destination and flashes a toast', async () => {
    const ada = await app.factory(UserFactory).create({ locale: 'en' });
    const sent = await app.actingAs(ada).post('/lab/chat', { form: { message: FIRST_MESSAGE }, headers: { referer: 'http://localhost/lab/chat' } }).assertRedirect('/lab/chat');
    app.notifications.assertSent({ type: 'user', id: ada.id }, LabChatNotification, (data) => data.message === FIRST_MESSAGE);
    app.chat.assertNothingQueued();

    await app.notifications.deliver();
    app.chat.assertQueuedCount(1);
    app.chat.assertQueued({ to: 'ops', title: 'A message from the lab', text: FIRST_MESSAGE });
    app.chat.assertQueued((m) => m.content.links?.length === 1 && m.content.links[0]!.url.startsWith('https://marmeon.com'));

    await app
      .actingAs(ada)
      .withCookie('marmeon_session', sent.cookie('marmeon_session')!)
      .navigating()
      .get('/lab/chat')
      .assertOk()
      .assertFlash('toast', { kind: 'success', message: 'The message is queued for the ops channel.' });
  });

  it('takes 500 characters and refuses 501', async () => {
    const ada = await app.factory(UserFactory).create();
    await app.actingAs(ada).post('/lab/chat', { json: { message: 'a'.repeat(500) }, headers: json }).assertRedirect('/lab/chat');
    app.notifications.assertSentTimes({ type: 'user', id: ada.id }, LabChatNotification, 1);
    const response = await app.actingAs(ada).post('/lab/chat', { json: { message: 'a'.repeat(501) }, headers: json }).assertUnprocessable();
    response.assertInvalid<SendChatLabController>({ message: /500/ });
    app.notifications.assertSentTimes({ type: 'user', id: ada.id }, LabChatNotification, 1);
  });

  it.each([
    ['nothing', ''],
    ['spaces', '   '],
    ['a bidirectional control', '\u202E'],
    ['control characters', '\u0001\u0002'],
    ['spaces around controls', ' \u202E \u2066 '],
  ])('refuses a message of %s and sends nothing', async (_name, message) => {
    const ada = await app.factory(UserFactory).create();
    const response = await app.actingAs(ada).post('/lab/chat', { json: { message }, headers: json }).assertUnprocessable();
    response.assertInvalid<SendChatLabController>({ message: 'The message field is required.' });
    app.notifications.assertNothingSent();
    app.chat.assertNothingQueued();
  });

  it('cleans control characters out of a message and still sends it, a newline kept', async () => {
    const ada = await app.factory(UserFactory).create();
    await app.actingAs(ada).post('/lab/chat', { json: { message: 'a\u202Eb\nc' }, headers: json }).assertRedirect('/lab/chat');
    await app.notifications.deliver();
    app.chat.assertQueued({ to: 'ops', text: 'ab\nc' });
  });

  it('sends nothing for a visitor who is not signed in, and sends the page of a guest to the sign-in', async () => {
    await app.post('/lab/chat', { json: { message: 'hello' }, headers: json }).assertUnauthorized();
    await app.navigating().get('/lab/chat').assertRedirect('/login');
    app.notifications.assertNothingSent();
  });

  it('refuses an account whose address is not confirmed', async () => {
    const eve = await app.factory(UserFactory).state('unverified').create();
    await app.actingAs(eve).post('/lab/chat', { json: { message: 'hello' }, headers: json }).assertForbidden();
    await app.actingAs(eve).get('/lab/chat').assertRedirect('/email/verify');
    app.notifications.assertNothingSent();
    app.chat.assertNothingQueued();
  });

  it('limits a user, not an address: ten posts a minute for each', async () => {
    const ada = await app.factory(UserFactory).create();
    const bob = await app.factory(UserFactory).create();
    for (let i = 0; i < 10; i++) await app.actingAs(ada).post('/lab/chat', { json: { message: 'hello' }, headers: json }).assertRedirect('/lab/chat');
    await app.actingAs(ada).post('/lab/chat', { json: { message: 'hello' }, headers: json }).assertStatus(429);
    await app.actingAs(bob).post('/lab/chat', { json: { message: 'hello' }, headers: json }).assertRedirect('/lab/chat');
  });

  it('says so, and sends nothing, when CHAT_WEBHOOKS lists no ops destination', async () => {
    await app.close();
    app = await createTestApp(application, { database: 'refresh', env: { LAB_PAGES: 'true', CHAT_WEBHOOKS: '' } });
    const ada = await app.factory(UserFactory).create();
    await app.actingAs(ada).navigating().get('/lab/chat').assertOk().assertPage('lab/Chat', { unavailable: 'No destination "ops" — CHAT_WEBHOOKS names none.' });
    const refused = await app.actingAs(ada).post('/lab/chat', { json: { message: 'hello' }, headers: json }).assertUnprocessable();
    refused.assertInvalid<SendChatLabController>({ message: 'No destination "ops" — CHAT_WEBHOOKS names none.' });
    app.notifications.assertNothingSent();
    app.chat.assertNothingQueued();
  });

  it('is a 404 unless the lab is on — for a guest and a signed-in user, GET and POST, whatever the limit says', async () => {
    // One database app per test: the one of `beforeEach` makes room.
    await app.close();
    app = await createTestApp(application, { database: 'refresh', env: { LAB_PAGES: 'false' } });
    const ada = await app.factory(UserFactory).create();
    await app.navigating().get('/lab/chat').assertNotFound();
    await app.post('/lab/chat', { json: { message: 'hello' }, headers: json }).assertNotFound();
    await app.actingAs(ada).navigating().get('/lab/chat').assertNotFound();
    for (let i = 0; i < 12; i++) await app.actingAs(ada).post('/lab/chat', { json: { message: 'hello' }, headers: json }).assertNotFound();
    app.notifications.assertNothingSent();
  });
});

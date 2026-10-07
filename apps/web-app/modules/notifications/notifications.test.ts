import { Login } from '@marmeon/auth';
import { Connections, sql } from '@marmeon/database';
import { notificationsChannel } from '@marmeon/live';
import { Inbox, Notifications, SendQueuedNotification } from '@marmeon/notifications';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { NewSignInNotification } from '../auth/index.ts';
import { UserFactory } from '../auth/factories/UserFactory.ts';
import { NotifyAboutNewSignIn } from '../auth/listeners/NotifyAboutNewSignIn.ts';
import { NewSignInMail } from '../auth/mail/NewSignInMail.ts';
import type { User } from '../auth/users.ts';
import type { ShowNotificationsController } from './controllers/ShowNotificationsController.ts';

const FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15.6; rv:142.0) Gecko/20100101 Firefox/142.0';

const signIn = (app: TestApp, user: User, headers: Record<string, string> = {}) =>
  app.post('/login', { form: { email: user.email, password: 'password' }, headers: { 'user-agent': FIREFOX, ...headers } }).assertRedirect('/users/me');

const me = (user: User) => ({ type: 'user', id: user.id }) as const;

/** The notifications rows of a user. */
async function rows(app: TestApp, user: User) {
  const { rows } = await sql<{ id: string; type: string; data: unknown; read_at: string | null }>`select id, type, data, read_at from notifications where recipient_type = 'user' and recipient_id = ${String(user.id)} order by created_at`.execute(
    app.make(Connections).get(),
  );
  return rows;
}

describe('"New sign-in" (W6.7)', () => {
  it('a sign-in with a password queues the Login listener, which notifies the user — bell and mail', async () => {
    const app = await createTestApp(application, { database: 'refresh' });
    const ada = await app.factory(UserFactory).create({ name: 'Ada', locale: 'en' });
    await signIn(app, ada);
    app.queue.assertListenerQueued(NotifyAboutNewSignIn, (payload) => payload.userId === ada.id && payload.via === 'attempt' && payload.userAgent === FIREFOX);
    app.notifications.assertNothingSent(); // in the request, nothing but the queued listener

    await app.queue.work();
    app.notifications.assertSent(me(ada), NewSignInNotification, (data) => data.agent === FIREFOX && !Number.isNaN(Date.parse(data.at)));
    await app.notifications.deliver();
    expect(await rows(app, ada)).toEqual([expect.objectContaining({ type: 'auth.new-sign-in', data: { at: expect.any(String), ip: null, browser: 'Firefox · macOS' }, read_at: null })]);
    app.mail.assertQueued(NewSignInMail, (_mail, message, options) => message.to[0]!.address === ada.email && message.subject === 'A new sign-in to Marmeon' && options.queue === 'mail');
  });

  it('writes the mail in the user\'s language, not the language of the sign-in (a German user, an English request)', async () => {
    const app = await createTestApp(application, { database: 'refresh' });
    const ada = await app.factory(UserFactory).create({ locale: 'de' });
    await signIn(app, ada, { 'accept-language': 'en' });
    await app.queue.work();
    await app.notifications.deliver();
    const [queued] = app.mail.queued(NewSignInMail);
    expect(queued!.message.subject).toBe('Neue Anmeldung bei Marmeon');
    expect(queued!.message.text).toContain('Firefox · macOS');
  });

  it('sends an unconfirmed address no mail (via) — the bell gets it all the same', async () => {
    const app = await createTestApp(application, { database: 'refresh' });
    const alan = await app.factory(UserFactory).state('unverified').create({ locale: 'en' });
    await signIn(app, alan);
    await app.queue.work();
    await app.notifications.deliver();
    expect(await rows(app, alan)).toHaveLength(1);
    app.mail.assertNotQueued(NewSignInMail);
  });

  it('is not sent for a registration — it signs nobody in (private registration, E146)', async () => {
    const app = await createTestApp(application, { database: 'refresh' });
    await app.post('/register', { form: { name: 'Katherine Johnson', email: 'kj@example.com', password: 'orbital mechanics', password_confirmation: 'orbital mechanics' } }).assertRedirect('/register/sent');
    app.events.assertNotDispatched(Login);
    await app.queue.work();
    app.notifications.assertNothingSent();
  });

  it('goes through the real notification job: one row, the mail queued with it', async () => {
    const app = await createTestApp(application, { database: 'refresh', notifications: 'real' });
    const ada = await app.factory(UserFactory).create({ locale: 'en' });
    await signIn(app, ada);
    await app.queue.work();
    expect(await rows(app, ada)).toHaveLength(1);
    app.mail.assertQueuedCount(NewSignInMail, 1);
    // send() (a queued delivery) works the same way — its job, then the row.
    await app.make(Notifications).send(me(ada), NewSignInNotification, { at: new Date().toISOString(), ip: '203.0.113.9', agent: null });
    app.queue.assertDispatched(SendQueuedNotification, { notification: 'auth.new-sign-in' });
    await app.queue.work();
    expect((await rows(app, ada)).map((row) => (row.data as { ip: string | null }).ip)).toEqual([null, '203.0.113.9']);
  });
});

describe('the bell and the list', () => {
  async function seeded() {
    const app = await createTestApp(application, { database: 'refresh', notifications: 'real' });
    const ada = await app.factory(UserFactory).create({ name: 'Ada', locale: 'en' });
    const alan = await app.factory(UserFactory).create({ name: 'Alan', locale: 'en' });
    const notifications = app.make(Notifications);
    const data = { at: '2026-10-03T08:00:00.000Z', ip: '203.0.113.9', agent: FIREFOX };
    const adas = [await notifications.sendNow(me(ada), NewSignInNotification, data), await notifications.sendNow(me(ada), NewSignInNotification, data)];
    const alans = await notifications.sendNow(me(alan), NewSignInNotification, data);
    return { app, ada, alan, adas, alans };
  }

  it('counts the unread notifications on every page (a shared prop) — nothing for guests', async () => {
    const { app, ada } = await seeded();
    await app.actingAs(ada).navigating().get('/users/me').assertRedirect();
    await app.actingAs(ada).navigating().get('/dashboard').assertOk().assertPage('dashboard/Show', { bell: { unread: 2 } });
    await app.navigating().get('/login').assertPage('auth/Login', { bell: null });
  });

  it('lists the user\'s own notifications, in their words', async () => {
    const { app, ada, adas } = await seeded();
    const page = app.actingAs(ada).navigating().get('/notifications').assertOk();
    await page.assertPage<ShowNotificationsController>('notifications/Index', { bell: { unread: 2 } });
    const { notifications } = (await page).page()!.props as { notifications: { data: { id: string; title: string; body: string; read: boolean }[]; meta: { nextCursor: string | null } } };
    expect(notifications.data.map((notification) => notification.id).sort()).toEqual([...adas].sort());
    expect(notifications.data[0]).toMatchObject({ title: 'New sign-in to your account', body: 'From 203.0.113.9 · Firefox · macOS', read: false });
    expect(notifications.meta.nextCursor).toBeNull();
  });

  it('marks one read — someone else\'s is a 404 and stays unread (IDOR)', async () => {
    const { app, ada, alan, adas, alans } = await seeded();
    await app.actingAs(ada).post(`/notifications/${alans}/read`, { json: {} }).assertNotFound();
    expect((await rows(app, alan))[0]!.read_at).toBeNull();
    await app.actingAs(ada).post('/notifications/not-a-uuid/read', { json: {} }).assertNotFound();

    await app.actingAs(ada).post(`/notifications/${adas[0]}/read`, { json: {} }).assertOk().assertJson({ read: adas[0] });
    expect(await app.make(Inbox).count(me(ada))).toBe(1);
    expect(await app.make(Inbox).count(me(alan))).toBe(1);
  });

  it('marks all of the user\'s read — nobody else\'s', async () => {
    const { app, ada, alan } = await seeded();
    await app.actingAs(ada).post('/notifications/read-all', { json: {} }).assertOk().assertJson({ read: 2 });
    expect(await app.make(Inbox).count(me(ada))).toBe(0);
    expect(await app.make(Inbox).count(me(alan))).toBe(1);
  });

  it('deletes one — someone else\'s is a 404 and stays (IDOR); the user\'s other tabs hear it', async () => {
    const { app, ada, alan, adas, alans } = await seeded();
    await app.actingAs(ada).delete(`/notifications/${alans}`, { json: {} }).assertNotFound();
    expect(await rows(app, alan)).toHaveLength(1);
    await app.actingAs(ada).delete('/notifications/not-a-uuid', { json: {} }).assertNotFound();
    // Another tab of Ada's (one browser, one session) follows the list.
    const ada$ = app.actingAs(ada);
    const other = await ada$.live((await ada$.navigating().get('/notifications')).page()!.live!);
    await other.hello();
    await ada$.delete(`/notifications/${adas[0]}`, { json: {} }).assertOk().assertJson({ deleted: adas[0] });
    expect((await rows(app, ada)).map((row) => row.id)).toEqual([adas[1]]);
    await other.waitFor(1);
    expect(other.hints).toEqual([{ channel: notificationsChannel(me(ada)), only: null, seq: expect.any(Number) }]);
  });

  it('loads more: ten at a time by an encrypted cursor, merged by the browser (data appended, matched on id) — a forged cursor is a 400', async () => {
    const { app, ada } = await seeded();
    const notifications = app.make(Notifications);
    for (let i = 0; i < 10; i++) {
      app.travel({ seconds: 1 });
      await notifications.sendNow(me(ada), NewSignInNotification, { at: '2026-10-03T08:00:00.000Z', ip: `203.0.113.${i}`, agent: FIREFOX });
    }
    type Feed = { data: { id: string; body: string }[]; meta: { nextCursor: string | null } };
    const first = (await app.actingAs(ada).navigating().get('/notifications').assertOk()).page()!;
    const feed = first.props.notifications as Feed;
    expect(feed.data).toHaveLength(10);
    expect(feed.data[0]!.body).toContain('203.0.113.9'); // newest first
    expect(first).toMatchObject({ mergeProps: ['notifications'], matchPropsOn: ['notifications.data.id'] });
    // The cursor is no row's data in plain text.
    expect(Buffer.from(feed.meta.nextCursor!, 'base64url').toString('latin1')).not.toContain('2026-');

    const more = (await app.actingAs(ada).reloading<ShowNotificationsController>('notifications/Index', { only: ['notifications'] }).get(`/notifications?cursor=${feed.meta.nextCursor}`).assertOk()).page()!;
    const next = more.props.notifications as Feed;
    expect(next.data).toHaveLength(2);
    expect(next.meta.nextCursor).toBeNull();
    expect(new Set([...feed.data, ...next.data].map((row) => row.id)).size).toBe(12);

    const forged = `${feed.meta.nextCursor!.slice(0, -2)}${feed.meta.nextCursor!.at(-2) === 'A' ? 'B' : 'A'}${feed.meta.nextCursor!.at(-1)}`;
    await app.actingAs(ada).navigating().get(`/notifications?cursor=${forged}`).assertStatus(400);
    await app.actingAs(ada).navigating().get('/notifications?cursor=not-a-cursor').assertStatus(400);
  });

  it('is only for signed-in users', async () => {
    const { app, adas } = await seeded();
    await app.get('/notifications').assertRedirect('/login');
    await app.post(`/notifications/${adas[0]}/read`, { json: {} }).assertRedirect('/login');
    await app.delete(`/notifications/${adas[0]}`, { json: {} }).assertRedirect('/login');
  });

  it('prunes what was read a month ago at night — unread ones stay', async () => {
    const { app, ada, adas } = await seeded();
    await app.make(Inbox).markRead(me(ada), adas[0]!);
    app.travel({ days: 31 });
    await app.schedule.runTask('notifications:prune --days=30');
    expect((await rows(app, ada)).map((row) => row.id)).toEqual([adas[1]]);
  });
});

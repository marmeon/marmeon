import { AccountSessions } from '@marmeon/auth';
import { SESSION_USER_KEY, SessionCodec, sessionKey, SessionStore } from '@marmeon/session';
import { cookieNames } from '@marmeon/auth/testing';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { AccountDeletion } from './AccountDeletion.ts';
import { UserFactory } from './factories/UserFactory.ts';
import { ResetPasswordMail } from './mail/ResetPasswordMail.ts';
import { WARM_UP_TIMEOUT, warmUp } from './warm-up.ts';

beforeAll(warmUp, WARM_UP_TIMEOUT);

let app: TestApp;
let SESSION: string;
let REMEMBER: string;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
  ({ session: SESSION, remember: REMEMBER } = cookieNames(app));
});

const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0';
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

describe('a live stream and the sign-in behind it', () => {
  const signIn = (email: string, userAgent: string) => app.post('/login', { form: { email, password: 'password' }, headers: { 'user-agent': userAgent } });
  const browser = (session: string) => app.withCookie(SESSION, session);
  /** The channels the signed-in browser's profile page follows, signed for its session. */
  const followed = async (session: string, publicId: string) => (await browser(session).navigating().get(`/users/${publicId}`).assertOk()).page()!.live!;

  async function adaInTwoBrowsers() {
    const ada = await app.factory(UserFactory).create();
    const laptop = (await signIn(ada.email, FIREFOX)).cookie(SESSION)!;
    const phone = (await signIn(ada.email, SAFARI)).cookie(SESSION)!;
    return { ada, laptop, phone, channels: await followed(phone, ada.public_id) };
  }

  it('opens for a valid sign-in, as it did', async () => {
    const { phone, channels } = await adaInTwoBrowsers();
    const stream = await browser(phone).live(channels);
    await stream.hello();
    expect(stream.status).toBe(200);
    expect(stream.events.map((each) => each.event)).toEqual(['hello']);
  });

  it('opens for a session without an account id, with auth bound — it is no sign-in to end', async () => {
    const { phone, channels } = await adaInTwoBrowsers();
    // The same session, the account's id taken out: a guest's session that holds valid tokens.
    const key = sessionKey(phone);
    const store = app.make(SessionStore);
    const codec = app.make(SessionCodec);
    const current = (await store.read(key))!;
    const data = JSON.parse((await codec.open(current.data, key))!) as Record<string, unknown>;
    delete data[SESSION_USER_KEY];
    const written = await store.write(key, await codec.seal(JSON.stringify(data), key), { expectedVersion: current.version, lifetimeSeconds: 7200, userId: null });
    expect(written).toBe('written');

    const stream = await browser(phone).live(channels);
    await stream.hello();
    expect(stream.events.map((each) => each.event)).toEqual(['hello']);
  });

  it('the `end` answer sets no cookie and writes no session', async () => {
    const { ada, phone, channels } = await adaInTwoBrowsers();
    expect((await app.make(AccountSessions).end(ada.id as never)).ok).toBe(true);
    const stream = await browser(phone).live(channels);
    await stream.closed;
    expect(stream.response.headers.get('set-cookie')).toBeNull();
  });

  it('gives a browser signed out by AccountSessions.end() no stream — `end` only, so it does not reconnect', async () => {
    const { ada, phone, channels } = await adaInTwoBrowsers();
    expect((await app.make(AccountSessions).end(ada.id as never)).ok).toBe(true);

    const stream = await browser(phone).live(channels);
    await stream.closed;
    expect(stream.status).toBe(200);
    expect(stream.events.map((each) => each.event)).toEqual(['end']);
  });

  it('gives a browser whose sign-in was ended from another browser no stream', async () => {
    const { laptop, phone, channels } = await adaInTwoBrowsers();
    const listed = (await browser(laptop).navigating().get('/settings/security', { headers: { 'user-agent': FIREFOX } })).page()!.props.signIns as readonly { id: string; current: boolean }[];
    const other = listed.find((entry) => !entry.current)!;
    const confirmed = await browser(laptop).post('/confirm-password', { form: { password: 'password' } });
    await browser(confirmed.cookie(SESSION) ?? laptop).post(`/settings/sign-ins/${other.id}/end`).assertRedirect('/settings/security');

    const stream = await browser(phone).live(channels);
    await stream.closed;
    expect(stream.events.map((each) => each.event)).toEqual(['end']);
  });

  it('gives a browser signed out by a new password on another device no stream — the device that changed it keeps its own', async () => {
    const { ada, laptop, phone, channels } = await adaInTwoBrowsers();
    const changed = await browser(laptop).put('/settings/password', { form: { current_password: 'password', password: 'a new password', password_confirmation: 'a new password' } });
    changed.assertRedirect();

    const stream = await browser(phone).live(channels);
    await stream.closed;
    expect(stream.events.map((each) => each.event)).toEqual(['end']);

    const mine = await browser(changed.cookie(SESSION)!).live(await followed(changed.cookie(SESSION)!, ada.public_id));
    await mine.hello();
    expect(mine.events.map((each) => each.event)).toEqual(['hello']);
  });
});

describe('a live stream that is open when its account\'s sign-ins end', () => {
  const signIn = (email: string, userAgent: string) => app.post('/login', { form: { email, password: 'password' }, headers: { 'user-agent': userAgent } });
  const browser = (session: string) => app.withCookie(SESSION, session);
  const followed = async (session: string, publicId: string) => (await browser(session).navigating().get(`/users/${publicId}`).assertOk()).page()!.live!;
  const eventsOf = (stream: { events: readonly { event: string }[] }) => stream.events.map((each) => each.event);

  async function twoAccounts() {
    const ada = await app.factory(UserFactory).create();
    const bob = await app.factory(UserFactory).create();
    const laptop = (await signIn(ada.email, FIREFOX)).cookie(SESSION)!;
    const phone = (await signIn(ada.email, SAFARI)).cookie(SESSION)!;
    const bobs = (await signIn(bob.email, FIREFOX)).cookie(SESSION)!;
    const open = async (session: string, user: { public_id: string }, connection: string) => {
      const stream = await browser(session).live(await followed(session, user.public_id), { connection });
      await stream.hello();
      return stream;
    };
    return { ada, bob, laptop, phone, bobs, open };
  }

  it('AccountSessions.end() closes every stream of the account at once — without `end`; another account\'s stream stays', async () => {
    const { ada, bob, laptop, phone, bobs, open } = await twoAccounts();
    const [onLaptop, onPhone, onBob] = [await open(laptop, ada, 'tab-l-0001'), await open(phone, ada, 'tab-p-0001'), await open(bobs, bob, 'tab-b-0001')];
    expect((await app.make(AccountSessions).end(ada.id as never)).ok).toBe(true);
    await Promise.all([onLaptop.closed, onPhone.closed]);
    expect(eventsOf(onLaptop)).toEqual(['hello']);
    expect(eventsOf(onPhone)).toEqual(['hello']);
    const state = await Promise.race([onBob.closed.then(() => 'closed'), new Promise((resolve) => setTimeout(() => resolve('open'), 100))]);
    expect(state).toBe('open');
  });

  it('a new password closes the streams of every device; the one that changed it connects again and stays, the others are told `end`', async () => {
    const { ada, laptop, phone, open } = await twoAccounts();
    const channels = await followed(phone, ada.public_id);
    const onLaptop = await open(laptop, ada, 'tab-l-0001');
    const onPhone = await open(phone, ada, 'tab-p-0001');
    const changed = await browser(laptop).put('/settings/password', { form: { current_password: 'password', password: 'a new password', password_confirmation: 'a new password' } });
    changed.assertRedirect();
    await Promise.all([onLaptop.closed, onPhone.closed]);
    expect(eventsOf(onLaptop)).toEqual(['hello']);
    expect(eventsOf(onPhone)).toEqual(['hello']);

    const mine = await browser(changed.cookie(SESSION)!).live(await followed(changed.cookie(SESSION)!, ada.public_id), { connection: 'tab-l-0002' });
    await mine.hello();
    const theirs = await browser(phone).live(channels, { connection: 'tab-p-0002' });
    await theirs.closed;
    expect(eventsOf(theirs)).toEqual(['end']);
  });

  it('ending a sign-in from the list closes the account\'s streams; the ended browser is told `end` when it connects again', async () => {
    const { ada, laptop, phone, open } = await twoAccounts();
    const channels = await followed(phone, ada.public_id);
    const onPhone = await open(phone, ada, 'tab-p-0001');
    const listed = (await browser(laptop).navigating().get('/settings/security', { headers: { 'user-agent': FIREFOX } })).page()!.props.signIns as readonly { id: string; current: boolean }[];
    const confirmed = await browser(laptop).post('/confirm-password', { form: { password: 'password' } });
    await browser(confirmed.cookie(SESSION) ?? laptop).post(`/settings/sign-ins/${listed.find((entry) => !entry.current)!.id}/end`).assertRedirect('/settings/security');
    await onPhone.closed;
    expect(eventsOf(onPhone)).toEqual(['hello']);
    const again = await browser(phone).live(channels, { connection: 'tab-p-0002' });
    await again.closed;
    expect(eventsOf(again)).toEqual(['end']);
  });

  it('a password reset by link closes the account\'s streams; the signed-out browser is told `end` when it connects again', async () => {
    const { ada, bob, phone, bobs, open } = await twoAccounts();
    const channels = await followed(phone, ada.public_id);
    const onPhone = await open(phone, ada, 'tab-p-0001');
    const onBob = await open(bobs, bob, 'tab-b-0001');
    await app.post('/forgot-password', { form: { email: ada.email }, headers: { referer: 'http://localhost/forgot-password' } });
    await app.queue.work();
    const [sent] = app.mail.queued(ResetPasswordMail).slice(-1);
    const link = new URL(/https?:\/\/\S+\/reset-password\?\S+(?=\))/.exec(sent!.message.text)![0]);
    const cookie = (await app.get(link.pathname + link.search).assertRedirect('/reset-password')).cookie('password_reset')!;
    const password = 'brand new password';
    await app.withCookie('password_reset', cookie).post('/reset-password', { form: { password, password_confirmation: password }, headers: { referer: 'http://localhost/reset-password' } }).assertRedirect('/login');

    await onPhone.closed;
    expect(eventsOf(onPhone)).toEqual(['hello']);
    const again = await browser(phone).live(channels, { connection: 'tab-p-0002' });
    await again.closed;
    expect(eventsOf(again)).toEqual(['end']);
    const state = await Promise.race([onBob.closed.then(() => 'closed'), new Promise((resolve) => setTimeout(() => resolve('open'), 100))]);
    expect(state).toBe('open');
  });

  it('signing out the other devices closes the account\'s streams; the phone is told `end`, this laptop connects again and stays', async () => {
    const { ada, laptop, phone, open } = await twoAccounts();
    const phoneChannels = await followed(phone, ada.public_id);
    const onPhone = await open(phone, ada, 'tab-p-0001');
    const onLaptop = await open(laptop, ada, 'tab-l-0001');
    const out = await browser(laptop).post('/settings/devices/logout', { form: { password: 'password' } }).assertRedirect('/settings/security');
    const here = out.cookie(SESSION) ?? laptop; // typing the password gave this browser's session a new id
    await Promise.all([onPhone.closed, onLaptop.closed]);
    expect(eventsOf(onPhone)).toEqual(['hello']);
    const again = await browser(phone).live(phoneChannels, { connection: 'tab-p-0002' });
    await again.closed;
    expect(eventsOf(again)).toEqual(['end']);
    const mine = await browser(here).live(await followed(here, ada.public_id), { connection: 'tab-l-0002' });
    await mine.hello();
  });

  it('a copied "keep me signed in" cookie that is used closes the account\'s streams; the browser is told `end` when it connects again', async () => {
    const { ada, bob, bobs, open } = await twoAccounts();
    const login = await app.post('/login', { form: { email: ada.email, password: 'password', remember: 'on' }, headers: { 'user-agent': FIREFOX } });
    const session = login.cookie(SESSION)!;
    const remember = login.cookie(REMEMBER)!;
    const channels = await followed(session, ada.public_id);
    const onSession = await open(session, ada, 'tab-r-0001');
    const onBob = await open(bobs, bob, 'tab-b-0001');

    await app.withCookie(REMEMBER, remember).get('/dashboard').assertOk(); // the copy is used first and rotates it
    app.travel({ seconds: 61 });
    await app.withCookie(REMEMBER, remember).get('/dashboard'); // the owner's stale value comes back

    await onSession.closed;
    expect(eventsOf(onSession)).toEqual(['hello']);
    const again = await browser(session).live(channels, { connection: 'tab-r-0002' });
    await again.closed;
    expect(eventsOf(again)).toEqual(['end']);
    const state = await Promise.race([onBob.closed.then(() => 'closed'), new Promise((resolve) => setTimeout(() => resolve('open'), 100))]);
    expect(state).toBe('open');
  });

  it('deleting the account closes its streams, and the browser is refused when it connects again', async () => {
    const { ada, phone, open } = await twoAccounts();
    const channels = await followed(phone, ada.public_id);
    const onPhone = await open(phone, ada, 'tab-p-0001');
    await app.make(AccountDeletion).delete([ada.id]);
    await onPhone.closed;
    expect(eventsOf(onPhone)).toEqual(['hello']);
    const again = await browser(phone).live(channels, { connection: 'tab-p-0002' });
    await again.closed;
    expect(eventsOf(again)).toEqual(['end']);
  });

  it('endEveryone() closes the streams of every account', async () => {
    const { ada, bob, laptop, bobs, open } = await twoAccounts();
    const [onAda, onBob] = [await open(laptop, ada, 'tab-l-0001'), await open(bobs, bob, 'tab-b-0001')];
    await app.make(AccountSessions).endEveryone();
    await Promise.all([onAda.closed, onBob.closed]);
    expect(eventsOf(onAda)).toEqual(['hello']);
    expect(eventsOf(onBob)).toEqual(['hello']);
  });
});

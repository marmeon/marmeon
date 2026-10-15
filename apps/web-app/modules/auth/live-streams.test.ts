import { AccountSessions } from '@marmeon/auth';
import { SESSION_USER_KEY, SessionCodec, sessionKey, SessionStore } from '@marmeon/session';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from './factories/UserFactory.ts';
import { WARM_UP_TIMEOUT, warmUp } from './warm-up.ts';

beforeAll(warmUp, WARM_UP_TIMEOUT);

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
});

const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0';
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

describe('a live stream and the sign-in behind it', () => {
  const signIn = (email: string, userAgent: string) => app.post('/login', { form: { email, password: 'password' }, headers: { 'user-agent': userAgent } });
  const browser = (session: string) => app.withCookie('marmeon_session', session);
  /** The channels the signed-in browser's profile page follows, signed for its session. */
  const followed = async (session: string, publicId: string) => (await browser(session).navigating().get(`/users/${publicId}`).assertOk()).page()!.live!;

  async function adaInTwoBrowsers() {
    const ada = await app.factory(UserFactory).create();
    const laptop = (await signIn(ada.email, FIREFOX)).cookie('marmeon_session')!;
    const phone = (await signIn(ada.email, SAFARI)).cookie('marmeon_session')!;
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
    await browser(confirmed.cookie('marmeon_session') ?? laptop).post(`/settings/sign-ins/${other.id}/end`).assertRedirect('/settings/security');

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

    const mine = await browser(changed.cookie('marmeon_session')!).live(await followed(changed.cookie('marmeon_session')!, ada.public_id));
    await mine.hello();
    expect(mine.events.map((each) => each.event)).toEqual(['hello']);
  });
});

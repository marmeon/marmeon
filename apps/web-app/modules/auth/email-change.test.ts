import { TwoFactor } from '@marmeon/auth/two-factor';
import { Limit, RateLimiter } from '@marmeon/cache';
import { Connections } from '@marmeon/database';
import { UrlSigner } from '@marmeon/http';
import type { Mailable } from '@marmeon/mail';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UpdateEmailController } from './controllers/UpdateEmailController.ts';
import { UserFactory } from './factories/UserFactory.ts';
import { SendEmailChangeMailJob } from './jobs/SendEmailChangeMailJob.ts';
import { ConfirmNewEmailMail } from './mail/ConfirmNewEmailMail.ts';
import { EmailChangedMail } from './mail/EmailChangedMail.ts';
import { EmailInUseMail } from './mail/EmailInUseMail.ts';
import { ResetPasswordMail } from './mail/ResetPasswordMail.ts';
import { VerifyEmailMail } from './mail/VerifyEmailMail.ts';
import type { User } from './users.ts';
import { UserRepository } from './UserRepository.ts';
import { WARM_UP_TIMEOUT, warmUp } from './warm-up.ts';

// Cold starts in a hook with its own time, not in the first test's 5 s (the worker's database, the queues, mjml, the mails).
beforeAll(warmUp, WARM_UP_TIMEOUT);

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
});

// The change of address with private registration (the default): pending until the link sent to the new address
// is clicked; a free and a taken address get the same answer in the same time; the owner of a taken one gets a note. With
// AUTH_PRIVATE_REGISTRATION=false it changes at once and says "taken".

type Session = ReturnType<TestApp['withCookie']>;
/** Signed in with the password — which also confirms it: the security settings' sudo mode. */
const signIn = async (user: User): Promise<Session> => {
  const login = await app.post('/login', { form: { email: user.email, password: 'password' } }).assertRedirect('/users/me');
  return app.withCookie('marmeon_session', login.cookie('marmeon_session')!);
};
const change = (session: Session, email: string) => session.put('/settings/email', { form: { email }, headers: { referer: 'http://localhost/settings/security' } });
const reload = (user: User) => app.make(UserRepository).find(user.id) as Promise<User>;
/** The link in the last queued mail of a class (to `address`) — path and query. */
const linkIn = <M extends Mailable>(Mail: abstract new (...args: any[]) => M, address?: string) => {
  const sent = app.mail.queued(Mail, (_mail, message) => address === undefined || message.to[0]!.address === address).at(-1)!;
  const url = new URL(/https?:\/\/\S+\/email\/change\/\S+(?=\))/.exec(sent.message.text)![0]);
  return url.pathname + url.search;
};
/** What a response says, without what differs per request anyway: the time, its id, the requests left — and cookie values. */
const answer = (response: { status: number; headers: Headers; body: string }) => ({
  status: response.status,
  headers: [...response.headers]
    .filter(([name]) => !['date', 'x-request-id', 'x-ratelimit-remaining'].includes(name))
    .map(([name, value]) => [name, name === 'set-cookie' ? value.replace(/=[^;]*/, '=…') : value]),
  body: response.body,
});
const pendingOn = async (session: Session) => ((await session.navigating().get('/settings/security').assertPage('auth/Security')).page()!.props as { pendingEmail: string | null }).pendingEmail;

describe('changing the address (private registration)', () => {
  it('keeps the account at its address until the link is clicked — then the new one is confirmed, the old one told', async () => {
    const kj = await app.factory(UserFactory).create({ email: 'kj@example.com' });
    const session = await signIn(kj);
    await change(session, ' Katherine@NASA.example ')
      .assertRedirect('/settings/security')
      .assertFlashed('toast', { message: 'We sent a link to the new address. Your address changes once you click it there — within 60 minutes, signed in.' });
    app.queue.assertDispatched(SendEmailChangeMailJob, { user: kj.id, email: 'katherine@nasa.example' });
    app.mail.assertNothingQueued(); // composed by a worker, never in the request (the time would show it)
    expect(await reload(kj)).toMatchObject({ email: 'kj@example.com', pending_email: 'katherine@nasa.example', email_verified_at: kj.email_verified_at });
    expect(await pendingOn(session)).toBe('katherine@nasa.example');

    await app.queue.work();
    app.mail.assertQueued(ConfirmNewEmailMail, (_mail, message, options) => message.to[0]!.address === 'katherine@nasa.example' && options.queue === 'mail');
    app.mail.assertNotQueued(EmailChangedMail);
    expect((await reload(kj)).email).toBe('kj@example.com');

    app.travel({ minutes: 30 });
    await session.get(linkIn(ConfirmNewEmailMail)).assertRedirect('/users/me').assertFlashed('toast', { message: 'Your e-mail address is now katherine@nasa.example.' });
    const changed = await reload(kj);
    expect(changed).toMatchObject({ email: 'katherine@nasa.example', pending_email: null, pending_email_expires_at: null });
    expect(Math.abs(new Date(changed.email_verified_at!).getTime() - app.clock.now())).toBeLessThan(1000);
    app.mail.assertQueued(EmailChangedMail, (_mail, message) => message.to[0]!.address === 'kj@example.com' && message.text.includes('katherine@nasa.example'));
    await session.post('/logout');
    await app.post('/login', { form: { email: 'katherine@nasa.example', password: 'password' } }).assertRedirect('/users/me');
  });

  it('answers a free address and a taken one byte for byte alike — the answer, and the page it leads to', async () => {
    await app.factory(UserFactory).create({ email: 'ada@example.com' });
    const session = await signIn(await app.factory(UserFactory).create({ email: 'kj@example.com' }));
    /**
     * The answer to a change, and the security page after it (its toast, its errors) — with the typed address (shown as pending) and
     * the flash message's id (random for every message) put aside.
     */
    const outcome = async (client: Session, email: string) => {
      const response = answer(await client.put('/settings/email', { form: { email }, headers: { referer: 'http://localhost/settings/security' } }));
      const page = answer(await session.navigating().get('/settings/security'));
      return { response, page: { ...page, body: page.body.replaceAll(email, '<typed>').replace(/"id":"[0-9a-f-]{36}","key"/g, '"id":"…","key"') } };
    };
    // Free addresses as long as the taken one: a page that shows what was typed is then as long for both.
    for (const [client, free] of [[session, 'bob@example.com'], [session.navigating(), 'eve@example.com'], [session.expectingJson(), 'joe@example.com']] as const) {
      const freeOutcome = await outcome(client, free);
      expect(await outcome(client, 'ada@example.com'), 'a taken address is answered differently from a free one').toEqual(freeOutcome);
      expect(freeOutcome.page.body).toContain('<typed>'); // the page shows the pending address — what was typed, either way
    }
  });

  // A timing test: a leak makes every attempt fail, a stall of a busy machine only some — so a failed attempt is tried again.
  it('takes as long for a taken address as for a free one — the request does the same either way (paired)', { retry: 2, timeout: 30_000 }, async () => {
    await app.factory(UserFactory).create({ email: 'ada@example.com' });
    const session = await signIn(await app.factory(UserFactory).create({ email: 'kj@example.com' }));
    app.freeze(); // no sudo window, throttle window or expiry passes while it measures
    // The throttle still counts every change — with room for all of them.
    app.make(RateLimiter).for('email-change', (ctx) => Limit.perMinute(1_000_000).by(String(ctx.user?.id)));
    // A change takes well under a millisecond — a busy machine's noise is larger than that. So a measurement is a run of four changes,
    // and a pair is two runs of each kind in mirrored order (free, taken, taken, free — the next pair the other way round: no "first
    // of the pair" effect). Twenty-one pairs counted, as for the registration, the first pair warms up; the median of the
    // paired ratios counts — a busy machine slows both halves of a pair alike, a lone stall moves one ratio, not the median.
    const run = async (kind: 'free' | 'taken', pair: number, n: number) => {
      const started = performance.now();
      for (let k = 0; k < 4; k++) await change(session, kind === 'free' ? `person${pair}.${n}.${k}@example.com` : 'ada@example.com').assertRedirect('/settings/security');
      return performance.now() - started;
    };
    const ratios: number[] = [];
    const took = { free: [] as number[], taken: [] as number[] };
    for (let i = 0; i <= 21; i++) {
      const pair = { free: 0, taken: 0 };
      const order = i % 2 === 0 ? (['free', 'taken', 'taken', 'free'] as const) : (['taken', 'free', 'free', 'taken'] as const);
      for (const [n, kind] of order.entries()) pair[kind] += await run(kind, i, n);
      if (i === 0) continue;
      ratios.push(pair.taken / pair.free);
      took.free.push(pair.free / 8);
      took.taken.push(pair.taken / 8);
    }
    const median = (values: number[]) => values.toSorted((a, b) => a - b)[(values.length - 1) / 2]!;
    const ratio = median(ratios);
    const seen = `median of ${ratios.length} paired ratios ${ratio.toFixed(3)} (a change: median taken ${median(took.taken).toFixed(2)} ms, free ${median(took.free).toFixed(2)} ms)`;
    expect(ratio, seen).toBeGreaterThan(0.75);
    expect(ratio, seen).toBeLessThan(1.33);
  });

  it('notes to the owner of a taken address that someone wanted it — nothing changes for anybody', async () => {
    const ada = await app.factory(UserFactory).create({ email: 'ada@example.com', name: 'Ada Lovelace', locale: 'de' });
    const kj = await app.factory(UserFactory).create({ email: 'kj@example.com' });
    await change(await signIn(kj), 'ADA@example.com').assertRedirect('/settings/security');
    await app.queue.work();
    app.mail.assertQueued(EmailInUseMail, (_mail, message) => message.to[0]!.address === 'ada@example.com' && message.subject === 'Jemand wollte deine E-Mail-Adresse verwenden');
    app.mail.assertNotQueued(ConfirmNewEmailMail);
    expect((await reload(kj)).email).toBe('kj@example.com');
    expect((await reload(ada)).email).toBe('ada@example.com');
  });

  it('a link works for the signed-in account it was made for — not for another, not tampered with, not for a guest', async () => {
    const kj = await app.factory(UserFactory).create({ email: 'kj@example.com' });
    const dv = await app.factory(UserFactory).create({ email: 'dv@example.com' });
    const asKj = await signIn(kj);
    await change(asKj, 'new@example.com');
    await app.queue.work();
    const link = linkIn(ConfirmNewEmailMail, 'new@example.com');
    // Whoever has the inbox of the new address, signed in as somebody else: nothing changes for either account.
    const asDv = await signIn(dv);
    await asDv.expectingJson().get(link).assertForbidden();
    const tampered = new URL(link, 'http://localhost');
    tampered.pathname = tampered.pathname.replace(`/${kj.id}/`, `/${dv.id}/`);
    await asDv.expectingJson().get(tampered.pathname + tampered.search).assertForbidden();
    await app.get(link, { headers: { accept: 'text/html' } }).assertRedirect('/login');
    expect(await reload(dv)).toMatchObject({ email: 'dv@example.com', pending_email: null });
    expect(await reload(kj)).toMatchObject({ email: 'kj@example.com', pending_email: 'new@example.com' });
    await asKj.get(link).assertRedirect('/users/me');
    expect((await reload(kj)).email).toBe('new@example.com');
  });

  it('tells whoever opens a link signed in as another account which account it is for', async () => {
    const kj = await app.factory(UserFactory).create({ email: 'kj@example.com' });
    await change(await signIn(kj), 'new@example.com');
    await app.queue.work();
    const asDv = await signIn(await app.factory(UserFactory).create({ email: 'dv@example.com' }));
    await asDv.expectingJson().get(linkIn(ConfirmNewEmailMail)).assertForbidden().assertExactJson({ message: 'This link is for another account. Sign in with that one, then open the link again.' });
  });

  it('a link works once — and only for the latest request', async () => {
    const kj = await app.factory(UserFactory).create({ email: 'kj@example.com' });
    const session = await signIn(kj);
    await change(session, 'first@example.com');
    await app.queue.work();
    const first = linkIn(ConfirmNewEmailMail, 'first@example.com');
    await change(session, 'second@example.com');
    await app.queue.work();
    const second = linkIn(ConfirmNewEmailMail, 'second@example.com');
    const refused = { message: 'This link no longer works — it was used, a newer one replaced it, or it expired. Change your address again on the security page.' };
    await session.expectingJson().get(first).assertForbidden().assertExactJson(refused);
    await session.get(second).assertRedirect('/users/me');
    await session.expectingJson().get(second).assertForbidden().assertExactJson(refused);
    expect((await reload(kj)).email).toBe('second@example.com');
    app.mail.assertQueuedCount(EmailChangedMail, 1);
  });

  it('a link past its own time is refused — even while the request would still wait (the signature)', async () => {
    const kj = await app.factory(UserFactory).create({ email: 'kj@example.com' });
    const session = await signIn(kj);
    await change(session, 'new@example.com');
    await app.queue.work();
    const link = linkIn(ConfirmNewEmailMail);
    app.travel({ minutes: 61 });
    await app.make(Connections).get<any>().updateTable('users').set({ pending_email_expires_at: new Date(app.clock.now() + 3_600_000) }).where('id', '=', kj.id).execute();
    await session.expectingJson().get(link).assertForbidden().assertExactJson({ message: 'Invalid signature.' });
    expect((await reload(kj)).email).toBe('kj@example.com');
  });

  it('a request past its time is refused — even while its link would still work (the row)', async () => {
    const kj = await app.factory(UserFactory).create({ email: 'kj@example.com' });
    const session = await signIn(kj);
    await change(session, 'new@example.com');
    await app.queue.work();
    await app.make(Connections).get<any>().updateTable('users').set({ pending_email_expires_at: new Date(app.clock.now() - 1000) }).where('id', '=', kj.id).execute();
    await session.expectingJson().get(linkIn(ConfirmNewEmailMail)).assertForbidden().assertExactJson({
      message: 'This link no longer works — it was used, a newer one replaced it, or it expired. Change your address again on the security page.',
    });
    expect((await reload(kj)).email).toBe('kj@example.com');
    expect(await pendingOn(session)).toBeNull(); // an expired request is not shown as waiting either
  });

  it('refuses the click when another account took the address in the meantime — the unique index decides', async () => {
    const kj = await app.factory(UserFactory).create({ email: 'kj@example.com' });
    const session = await signIn(kj);
    await change(session, 'grace@example.com');
    await app.queue.work();
    const link = linkIn(ConfirmNewEmailMail);
    await app.factory(UserFactory).create({ email: 'grace@example.com' }); // registered after the link went out
    await session.expectingJson().get(link).assertStatus(409).assertExactJson({ message: 'Another account uses this address by now. Your address stays as it was.' });
    expect(await reload(kj)).toMatchObject({ email: 'kj@example.com', pending_email: null });
    app.mail.assertNotQueued(EmailChangedMail);
  });

  it('drops the request for good when the address was taken — its link stays refused once the address is free again', async () => {
    const kj = await app.factory(UserFactory).create({ email: 'kj@example.com' });
    const session = await signIn(kj);
    await change(session, 'grace@example.com');
    await app.queue.work();
    const link = linkIn(ConfirmNewEmailMail);
    const grace = await app.factory(UserFactory).create({ email: 'grace@example.com' });
    await session.expectingJson().get(link).assertStatus(409);
    await app.make(Connections).get<any>().deleteFrom('users').where('id', '=', grace.id).execute();
    await session.expectingJson().get(link).assertForbidden().assertExactJson({
      message: 'This link no longer works — it was used, a newer one replaced it, or it expired. Change your address again on the security page.',
    });
    expect(await reload(kj)).toMatchObject({ email: 'kj@example.com', pending_email: null });
    expect(await pendingOn(session)).toBeNull();
  });

  it('a pending address signs nobody in — and gets no reset link', async () => {
    const kj = await app.factory(UserFactory).create({ email: 'kj@example.com' });
    await change(await signIn(kj), 'new@example.com');
    await app.post('/login', { form: { email: 'new@example.com', password: 'password' }, headers: { referer: 'http://localhost/login' } }).assertRedirect('/login').assertInvalid(['email']).assertGuest();
    await app.post('/forgot-password', { form: { email: 'new@example.com' } });
    await app.queue.work();
    app.mail.assertNotQueued(ResetPasswordMail);
  });

  it('the account’s own address again drops a pending change', async () => {
    const kj = await app.factory(UserFactory).create({ email: 'kj@example.com' });
    const session = await signIn(kj);
    await change(session, 'new@example.com');
    await app.queue.work();
    const link = linkIn(ConfirmNewEmailMail);
    await change(session, 'KJ@example.com').assertRedirect('/settings/security');
    expect(await pendingOn(session)).toBeNull();
    await session.expectingJson().get(link).assertForbidden();
  });

  it('throttles changes: the seventh a minute from one account gets 429', async () => {
    const session = await signIn(await app.factory(UserFactory).create({ email: 'kj@example.com' }));
    for (let i = 1; i <= 6; i++) await change(session, `new${i}@example.com`).assertRedirect('/settings/security');
    await change(session, 'new7@example.com').assertStatus(429);
  });

  it('the nightly prune clears the changes nobody confirmed in time — waiting ones stay', async () => {
    app.freeze(Date.parse('2026-10-05T20:00:00Z'));
    const kj = await app.factory(UserFactory).create({ email: 'kj@example.com' });
    const dv = await app.factory(UserFactory).create({ email: 'dv@example.com' });
    await change(await signIn(kj), 'old-request@example.com');
    app.travelTo(Date.parse('2026-10-06T00:40:00Z'));
    await change(await signIn(dv), 'fresh-request@example.com');
    expect(app.schedule.due('2026-10-06T03:10:00+02:00')).toContain('auth.prune-email-changes');
    const results = await app.schedule.run('2026-10-06T03:10:00+02:00');
    expect(results.find((result) => result.task === 'auth.prune-email-changes')?.outcome).toBe('ran');
    expect(await reload(kj)).toMatchObject({ email: 'kj@example.com', pending_email: null, pending_email_expires_at: null });
    expect(await reload(dv)).toMatchObject({ pending_email: 'fresh-request@example.com' });
  });
});

describe('changing the address with AUTH_PRIVATE_REGISTRATION=false', () => {
  beforeEach(async () => {
    await app.close();
    app = await createTestApp(application, { database: 'refresh', env: { AUTH_PRIVATE_REGISTRATION: 'false' } });
  });

  it('changes it at once, unconfirmed — a link to the new address, a note to the old one; the settings stay open to fix a typo', async () => {
    const kj = await app.factory(UserFactory).create({ email: 'kj@example.com' });
    const session = await signIn(kj);
    await change(session, 'katherine@nasa.example').assertRedirect('/settings/security').assertFlashed('toast', { message: 'E-mail address changed. Please confirm the new one — we sent you a link.' });
    expect(await reload(kj)).toMatchObject({ email: 'katherine@nasa.example', email_verified_at: null, pending_email: null });
    app.queue.assertNotDispatched(SendEmailChangeMailJob);
    app.mail.assertQueued(VerifyEmailMail, (_mail, message) => message.to[0]!.address === 'katherine@nasa.example');
    app.mail.assertQueued(EmailChangedMail, (_mail, message) => message.to[0]!.address === 'kj@example.com');
    expect(await pendingOn(session)).toBeNull();
    await change(session, 'katherine@nasa.example.com').assertRedirect('/settings/security');
    expect((await reload(kj)).email).toBe('katherine@nasa.example.com');
  });

  it('says that an address is taken — and has no change links', async () => {
    await app.factory(UserFactory).create({ email: 'ada@example.com' });
    const kj = await app.factory(UserFactory).create({ email: 'kj@example.com' });
    const session = await signIn(kj);
    await change(session, 'ada@example.com').assertInvalid({ email: 'This e-mail address is already registered.' });
    expect((await reload(kj)).email).toBe('kj@example.com');
    const link = new URL(app.make(UrlSigner).temporarySignedRoute('auth.email.confirm', { id: kj.id, token: 'token' }, 600), 'http://localhost');
    await session.expectingJson().get(link.pathname + link.search).assertNotFound();
  });
});

describe('the change of address asks for a recent factor itself', () => {
  /** The controller built from the container, with the check of the second factor answering `check`: no route, no middleware in front of it. */
  const controllerAsking = (check: () => Promise<void>) => {
    const scope = app.container.createScope();
    scope.instance(TwoFactor, { requireRecentProof: check } as unknown as TwoFactor);
    return scope.make(UpdateEmailController);
  };
  const handle = (controller: UpdateEmailController, user: User, email: string) => controller.handle({ body: { email }, user } as never);

  it('throws before anything is stored when the session has no recent factor — even on a route without confirmedSecondFactor()', async () => {
    const kj = await app.factory(UserFactory).create({ email: 'kj@example.com' });
    const asked: string[] = [];
    const stale = controllerAsking(async () => {
      asked.push('changeEmail');
      throw new Error('twoFactor.requireRecentProof(\'changeEmail\') needs a second factor proven within 15 minutes on an account that has one — put the route behind confirmedSecondFactor().');
    });
    await expect(handle(stale, kj, 'katherine@nasa.example')).rejects.toThrow('second factor proven within 15 minutes');
    expect(asked).toEqual(['changeEmail']);
    expect(await reload(kj)).toMatchObject({ email: 'kj@example.com', pending_email: null });
    app.queue.assertNothingDispatched();
  });

  it('goes on when the check passes', async () => {
    const kj = await app.factory(UserFactory).create({ email: 'kj@example.com' });
    await handle(controllerAsking(async () => {}), kj, 'katherine@nasa.example');
    expect((await reload(kj)).pending_email).toBe('katherine@nasa.example');
  });
});

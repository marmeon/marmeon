import { UserRepository, type User } from '#modules/auth';
import { NotifyEditorOfSignIn, NotifyEditorOfTwoFactorDisabled, OfficeGuard, OfficeSecurityMail, type OfficeUser } from '@fixtures/back-office';
import { softAuthenticator, twoFactorCode } from '@marmeon/auth/testing';
import { Connections } from '@marmeon/database';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { WARM_UP_TIMEOUT, warmUpDatabase } from '../auth/warm-up.ts';

beforeAll(warmUpDatabase, WARM_UP_TIMEOUT);

// What the second factors of the back office refuse and limit: the step-up page, the limits of the routes, the requests that run one at a time, the
// device cookie, the page a sign-in goes on to, and what the mail listeners will not do. The flows are in `back-office-second-factor.test.ts`.
let app: TestApp;
let ada: User;
let eve: OfficeUser;
let victor: OfficeUser;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh', seed: true });
  const customers: User[] = await app.make(UserRepository).query().selectAll().orderBy('id').execute();
  [ada] = customers as [User, ...User[]];
  [eve, victor] = (await app.make(Connections).get().selectFrom('office_users').select(['id', 'name', 'email', 'role']).orderBy('id').execute()) as [OfficeUser, OfficeUser];
}, 30_000);
afterEach(() => app.close());

const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0';
const DEVICE = 'marmeon_device.office.device';
const browser = () => app.keepingCookies().withHeaders({ 'user-agent': FIREFOX });
const editorSignsIn = (as: TestApp, who: { email: string }, password = 'password') => as.post('/office/login', { form: { email: who.email, password } });
const propsOf = async (as: TestApp, path: string) => (await as.navigating().get(path)).page()!.props as Record<string, any>;
const device = () => softAuthenticator({ origin: 'http://localhost', rpId: 'localhost' });
const inSeconds = (seconds: number) => new Date(app.clock.now() + seconds * 1000);
const FAILED = { error: 'That did not work.' };
const answers = (response: { status: number; json(): unknown }, status: number, body: unknown) => expect([response.status, response.json()]).toEqual([status, body]);

async function enable(as: TestApp) {
  await as.post('/office/security/two-factor/setup').assertRedirect('/office/security');
  const { secret } = (await propsOf(as, '/office/security')).setup as { secret: string };
  const done = await as.layering().post('/office/security/two-factor/confirm', { form: { code: twoFactorCode(secret, new Date(app.clock.now())), password: 'password' } }).assertLayer('office::RecoveryCodes');
  return { secret, recoveryCodes: done.page()!.props.codes as string[] };
}

async function enrol(as: TestApp, authenticator = device()) {
  const options = await as.post('/office/security/passkeys/options', { json: {} }).assertOk();
  await as.post('/office/security/passkeys', { json: { response: authenticator.register(options.json() as never), name: 'Laptop', password: 'password' } }).assertOk();
  return authenticator;
}

/** Eve with an authenticator app and a passkey, signed in, and then twenty minutes later: the sudo window and the proof of her factor have run out. */
async function stale() {
  const editor = browser();
  await editorSignsIn(editor, eve).assertRedirect('/office');
  const { secret, recoveryCodes } = await enable(editor);
  const authenticator = await enrol(editor);
  app.travel({ minutes: 20 });
  await editor.post('/office/confirm-password', { form: { password: 'password' } }).assertRedirect();
  await editor.get('/office/security').assertRedirect('/office/two-factor-verify');
  return { editor, secret, recoveryCodes, authenticator };
}

describe('proving a factor again, after the sudo window', () => {
  const verify = 'http://localhost/office/two-factor-verify';

  it('takes the right code, goes on to the security page, and has it open', async () => {
    const { editor, secret } = await stale();
    await editor.post('/office/two-factor-verify', { form: { code: twoFactorCode(secret, inSeconds(0)) } }).assertRedirect('/office/security');
    await editor.navigating().get('/office/security').assertOk().assertPage('office::Security', { enabled: true });
  });

  it('takes a recovery code once, and the second use is refused', async () => {
    const { editor, recoveryCodes } = await stale();
    await editor.post('/office/two-factor-verify', { form: { recovery_code: recoveryCodes[0]! } }).assertRedirect('/office/security');
    await editor.navigating().get('/office/security').assertOk().assertPage('office::Security');
    app.travel({ minutes: 20 });
    await editor.post('/office/confirm-password', { form: { password: 'password' } }).assertRedirect();
    await editor.post('/office/two-factor-verify', { form: { recovery_code: recoveryCodes[0]! }, headers: { referer: verify } }).assertInvalid({ recovery_code: 'That recovery code did not work.' });
    await editor.get('/office/security').assertRedirect('/office/two-factor-verify');
  });

  it('takes the editor’s passkey', async () => {
    const { editor, authenticator } = await stale();
    const options = await editor.post('/office/two-factor-verify/passkey/options', { json: {} }).assertOk();
    await editor.post('/office/two-factor-verify/passkey', { json: { response: authenticator.authenticate(options.json() as never) } }).assertRedirect('/office/security');
    await editor.navigating().get('/office/security').assertOk().assertPage('office::Security');
  });

  it('goes on to the security page though the page stored last is the app’s, and to a stored page of the back office', async () => {
    const { editor, secret, recoveryCodes, authenticator } = await stale();
    // A signed-in editor is a guest of the app: this stores the app's page as the one to go back to.
    await editor.get('/dashboard').assertRedirect('/login');
    await editor.post('/office/two-factor-verify', { form: { code: twoFactorCode(secret, inSeconds(0)) } }).assertRedirect('/office/security');
    app.travel({ minutes: 20 });
    await editor.post('/office/confirm-password', { form: { password: 'password' } }).assertRedirect();
    await editor.get('/office/security').assertRedirect('/office/two-factor-verify');
    await editor.post('/office/two-factor-verify', { form: { recovery_code: recoveryCodes[0]! } }).assertRedirect('/office/security');
    // The same for a passkey.
    app.travel({ minutes: 20 });
    await editor.post('/office/confirm-password', { form: { password: 'password' } }).assertRedirect();
    await editor.get('/office/security').assertRedirect('/office/two-factor-verify');
    await editor.get('/dashboard').assertRedirect('/login');
    const options = await editor.post('/office/two-factor-verify/passkey/options', { json: {} }).assertOk();
    await editor.post('/office/two-factor-verify/passkey', { json: { response: authenticator.authenticate(options.json() as never) } }).assertRedirect('/office/security');
  });

  it('refuses another editor’s passkey, with the answer for every failure, and the page stays closed', async () => {
    const { editor } = await stale();
    const viewer = browser();
    await editorSignsIn(viewer, victor);
    const victors = await enrol(viewer);
    // Fresh options before each attempt: a failed answer spends the challenge.
    const options = await editor.post('/office/two-factor-verify/passkey/options', { json: {} }).assertOk();
    answers(await editor.post('/office/two-factor-verify/passkey', { json: { response: victors.authenticate({ challenge: (options.json() as { challenge: string }).challenge }) } }), 422, FAILED);
    const again = await editor.post('/office/two-factor-verify/passkey/options', { json: {} }).assertOk();
    const stranger = device();
    stranger.register({ challenge: 'AAAA', user: { id: 'AAAA' } });
    answers(await editor.post('/office/two-factor-verify/passkey', { json: { response: stranger.authenticate({ challenge: (again.json() as { challenge: string }).challenge }) } }), 422, FAILED);
    await editor.get('/office/security').assertRedirect('/office/two-factor-verify');
  });

  it('refuses another editor’s recovery code and code, and the page stays closed', async () => {
    const { editor } = await stale();
    const viewer = browser();
    await editorSignsIn(viewer, victor);
    await viewer.post('/office/security/two-factor/setup').assertRedirect('/office/security');
    const { secret: victorsSecret } = (await propsOf(viewer, '/office/security')).setup as { secret: string };
    const victors = await viewer.layering().post('/office/security/two-factor/confirm', { form: { code: twoFactorCode(victorsSecret, new Date(app.clock.now())), password: 'password' } }).assertLayer('office::RecoveryCodes');
    const codes = victors.page()!.props.codes as string[];
    await editor.post('/office/two-factor-verify', { form: { recovery_code: codes[0]! }, headers: { referer: verify } }).assertInvalid({ recovery_code: 'That recovery code did not work.' });
    await editor.post('/office/two-factor-verify', { form: { code: twoFactorCode(victorsSecret, inSeconds(30)) }, headers: { referer: verify } }).assertInvalid({ code: 'That code did not work.' });
    await editor.get('/office/security').assertRedirect('/office/two-factor-verify');
    await editor.post('/office/security/two-factor/disable', { form: { password: 'password' } }).assertRedirect('/office/two-factor-verify');
  });
});

describe('what Eve waits for while another editor’s factors are offered', () => {
  const challenge = 'http://localhost/office/two-factor-challenge';

  it('offers both the code and the passkey when the editor has both', async () => {
    const editor = browser();
    await editorSignsIn(editor, eve);
    await enable(editor);
    await enrol(editor);
    const waiting = browser();
    await editorSignsIn(waiting, eve).assertRedirect('/office/two-factor-challenge');
    await waiting.navigating().get('/office/two-factor-challenge').assertOk().assertPage('office::Challenge', { step: 'sign-in', totp: true, passkey: true });
  });

  it('refuses Victor’s code and passkey at the second step of Eve’s sign-in', async () => {
    const editor = browser();
    await editorSignsIn(editor, eve);
    await enable(editor);
    await enrol(editor);
    const viewer = browser();
    await editorSignsIn(viewer, victor);
    await viewer.post('/office/security/two-factor/setup').assertRedirect('/office/security');
    const { secret } = (await propsOf(viewer, '/office/security')).setup as { secret: string };
    await viewer.layering().post('/office/security/two-factor/confirm', { form: { code: twoFactorCode(secret, new Date(app.clock.now())), password: 'password' } }).assertLayer('office::RecoveryCodes');
    const victors = await enrol(viewer);

    const waiting = browser();
    await editorSignsIn(waiting, eve).assertRedirect('/office/two-factor-challenge');
    await waiting.post('/office/two-factor-challenge', { form: { code: twoFactorCode(secret, inSeconds(30)) }, headers: { referer: challenge } }).assertInvalid({ code: 'That code did not work.' });
    const options = await waiting.post('/office/two-factor-challenge/passkey/options', { json: {} }).assertOk();
    answers(await waiting.post('/office/two-factor-challenge/passkey', { json: { response: victors.authenticate({ challenge: (options.json() as { challenge: string }).challenge }) } }), 422, FAILED);
    await waiting.get('/office').assertRedirect('/office/login');
  });

  it('refuses a suspended passkey at the sign-in, with the answer for every failure', async () => {
    const editor = browser();
    await editorSignsIn(editor, eve);
    const authenticator = await enrol(editor);
    await editor.post('/office/logout');
    await app.make(Connections).get<any>().updateTable('office_passkeys').set({ suspended_at: new Date(app.clock.now()).toISOString() }).execute();
    const guest = browser();
    const options = await guest.post('/office/passkeys/sign-in/options', { json: {} }).assertOk();
    answers(await guest.post('/office/passkeys/sign-in', { json: { response: authenticator.authenticate(options.json() as never) } }), 422, FAILED);
    await guest.get('/office').assertRedirect('/office/login');
  });
});

describe('removing a passkey', () => {
  it('keeps the recovery codes while the authenticator app is on', async () => {
    const editor = browser();
    await editorSignsIn(editor, eve);
    await enable(editor);
    await enrol(editor);
    const db = app.make(Connections).get<any>();
    const [{ id }] = (await db.selectFrom('office_passkeys').select('id').execute()) as [{ id: number }];
    await editor.post(`/office/security/passkeys/${id}/remove`, { json: { password: 'password' } }).assertOk();
    expect(await db.selectFrom('office_passkeys').select('id').execute()).toEqual([]);
    expect(await db.selectFrom('office_two_factor_recovery_codes').select('id').execute()).toHaveLength(10);
    expect(await propsOf(editor, '/office/security')).toMatchObject({ enabled: true, passkeys: [], recoveryCodesLeft: 10 });
  });
});

describe('an editor whose role is gone', () => {
  it('opens none of the pages and requests of the factors: 403', async () => {
    const editor = browser();
    await editorSignsIn(editor, eve).assertRedirect('/office');
    await app.make(Connections).get().updateTable('office_users').set({ role: 'suspended' }).where('id', '=', eve.id).execute();
    for (const path of ['/office/security', '/office/two-factor-verify', '/office/security/two-factor/confirm']) await editor.get(path).assertForbidden();
    for (const path of ['/office/security/two-factor/setup', '/office/security/passkeys/options', '/office/security/passkeys', '/office/confirm-password/passkey/options', '/office/two-factor-verify/passkey/options', '/office/two-factor-verify']) {
      await editor.post(path, { json: {} }).assertForbidden();
    }
  });
});

describe('the limits of the routes', () => {
  // Each limit is the guard's own copy: the same client or user is not counted at the app's route of the same job.
  const guest = (officePath: string, appPath: string, limit: number, json: object = {}): [string, string, number, object, boolean] => [officePath, appPath, limit, json, false];
  const signedIn = (officePath: string, appPath: string, limit: number): [string, string, number, object, boolean] => [officePath, appPath, limit, {}, true];
  it.each([
    ['two-factor-challenge', ...guest('/office/two-factor-challenge', '/two-factor-challenge', 10, { code: '000000' })],
    ['passkey-sign-in-options', ...guest('/office/passkeys/sign-in/options', '/passkeys/sign-in/options', 30)],
    ['passkey-sign-in', ...guest('/office/passkeys/sign-in', '/passkeys/sign-in', 10, { response: {} })],
    ['passkey-challenge-options', ...guest('/office/two-factor-challenge/passkey/options', '/two-factor-challenge/passkey/options', 10)],
    ['passkey-challenge', ...guest('/office/two-factor-challenge/passkey', '/two-factor-challenge/passkey', 10, { response: {} })],
    ['passkey-confirm-options', ...signedIn('/office/confirm-password/passkey/options', '/confirm-password/passkey/options', 10)],
    ['passkey-step-up-options', ...signedIn('/office/two-factor-verify/passkey/options', '/settings/two-factor/verify/passkey/options', 10)],
  ])('%s: the request after the limit is 429 at the back office, and the app’s own count of the same client and user id is untouched', async (_, officePath, appPath, limit, body, authenticated) => {
    // Eve and Ada have one id: a per-user limit would share its key if the names did not differ.
    const office = authenticated ? browser() : app;
    const customer = authenticated ? browser() : app;
    if (authenticated) {
      await editorSignsIn(office, eve).assertRedirect('/office');
      await customer.post('/login', { form: { email: ada.email, password: 'password' } }).assertRedirect();
    }
    const statuses: number[] = [];
    for (let n = 0; n <= limit; n++) statuses.push((await office.post(officePath, { [body && 'response' in body ? 'json' : 'form']: body } as never)).status);
    expect(statuses.slice(0, limit)).not.toContain(429);
    expect(statuses[limit]).toBe(429);
    // The app's route of the same job still has its whole count.
    for (let n = 0; n < limit; n++) expect((await customer.post(appPath, { [body && 'response' in body ? 'json' : 'form']: body } as never)).status, `the app's request ${n + 1}`).not.toBe(429);
  });
});

describe('requests of one session at a time', () => {
  it('lets one of two parallel posts of the same recovery code sign in, and refuses the other', async () => {
    const editor = browser();
    await editorSignsIn(editor, eve);
    const { recoveryCodes } = await enable(editor);
    const waiting = browser();
    await editorSignsIn(waiting, eve).assertRedirect('/office/two-factor-challenge');
    const responses = await Promise.all([1, 2].map(() => waiting.post('/office/two-factor-challenge', { form: { recovery_code: recoveryCodes[0]! }, headers: { referer: 'http://localhost/office/two-factor-challenge' } })));
    expect(responses.map((response) => response.headers.get('location')).toSorted()).toEqual(['/office', '/office/login']);
    const [winner] = responses.filter((response) => response.headers.get('location') === '/office');
    expect(winner).toBeDefined();
    const db = app.make(Connections).get<any>();
    expect((await db.selectFrom('office_two_factor_recovery_codes').select('id').where('used_at', 'is not', null).execute()).length).toBe(1);
  });

  // The block of `/office/passkeys/sign-in` and `office.passkeys.challenge` is defence in depth: the one-time challenge already refuses the second answer, so
  // no test here claims it. The routes below change what the session proved or what the editor owns, and each is proven by its own pair of parallel requests.
  const statuses = (responses: { status: number }[]) => responses.map((response) => response.status).toSorted();

  it('proves a code once at the step-up page: the same code in parallel passes once', async () => {
    const { editor, secret } = await stale();
    const code = twoFactorCode(secret, inSeconds(0));
    const responses = await Promise.all([1, 2].map(() => editor.post('/office/two-factor-verify', { form: { code }, headers: { referer: 'http://localhost/office/two-factor-verify' } })));
    expect(statuses(responses)).toEqual([302, 303]);
  });

  it('proves a passkey answer once at the step-up page', async () => {
    const { editor, authenticator } = await stale();
    const options = await editor.post('/office/two-factor-verify/passkey/options', { json: {} }).assertOk();
    const response = authenticator.authenticate(options.json() as never);
    expect(statuses(await Promise.all([1, 2].map(() => editor.post('/office/two-factor-verify/passkey', { json: { response } }))))).toEqual([302, 303]);
  });

  it('opens the sudo window with one passkey answer once', async () => {
    const editor = browser();
    await editorSignsIn(editor, eve);
    const authenticator = await enrol(editor);
    app.travel({ minutes: 20 });
    const options = await editor.post('/office/confirm-password/passkey/options', { json: {} }).assertOk();
    const response = authenticator.authenticate(options.json() as never);
    expect(statuses(await Promise.all([1, 2].map(() => editor.post('/office/confirm-password/passkey', { json: { response } }))))).toEqual([302, 303]);
  });

  it('adds one passkey for one registration, however often it is posted at once', async () => {
    const editor = browser();
    await editorSignsIn(editor, eve);
    const options = await editor.post('/office/security/passkeys/options', { json: {} }).assertOk();
    const response = device().register(options.json() as never);
    const responses = await Promise.all([1, 2].map(() => editor.post('/office/security/passkeys', { json: { response, name: 'Laptop', password: 'password' } })));
    expect(statuses(responses)).toEqual([200, 302]);
    expect(await app.make(Connections).get<any>().selectFrom('office_passkeys').select('id').execute()).toHaveLength(1);
  });

  it('removes two passkeys of one session one after the other: the second finds the session replaced, one passkey and the recovery codes are left', async () => {
    const editor = browser();
    await editorSignsIn(editor, eve);
    await enrol(editor);
    await enrol(editor);
    const db = app.make(Connections).get<any>();
    const ids = ((await db.selectFrom('office_passkeys').select('id').orderBy('id').execute()) as { id: number }[]).map((row) => row.id);
    expect(ids).toHaveLength(2);
    const responses = await Promise.all(ids.map((id) => editor.post(`/office/security/passkeys/${id}/remove`, { json: { password: 'password' } })));
    expect(statuses(responses)).toEqual([200, 302]);
    expect(await db.selectFrom('office_passkeys').select('id').execute()).toHaveLength(1);
    expect(await db.selectFrom('office_two_factor_recovery_codes').select('id').execute()).toHaveLength(10);
  });

  it('lets one of two parallel passkey answers of one challenge sign in', async () => {
    const editor = browser();
    await editorSignsIn(editor, eve);
    const authenticator = await enrol(editor);
    await editor.post('/office/logout');
    const guest = browser();
    const options = await guest.post('/office/passkeys/sign-in/options', { json: {} }).assertOk();
    const response = authenticator.authenticate(options.json() as never);
    const answers = await Promise.all([1, 2].map(() => guest.post('/office/passkeys/sign-in', { json: { response } })));
    expect(answers.map((answer) => answer.status).toSorted()).toEqual([303, 422]);
  });
});

describe('the device cookie', () => {
  it('is set after a right code and after a right passkey at the second step, and not after a passkey sign-in', async () => {
    const editor = browser();
    await editorSignsIn(editor, eve);
    const { secret } = await enable(editor);
    const authenticator = await enrol(editor);
    await editor.post('/office/logout');

    const withCode = browser();
    await editorSignsIn(withCode, eve).assertRedirect('/office/two-factor-challenge');
    const coded = await withCode.post('/office/two-factor-challenge', { form: { code: twoFactorCode(secret, inSeconds(30)) } }).assertRedirect('/office');
    expect(coded.cookie(DEVICE)).toBeTruthy();

    const withPasskey = browser();
    await editorSignsIn(withPasskey, eve).assertRedirect('/office/two-factor-challenge');
    const challenge = await withPasskey.post('/office/two-factor-challenge/passkey/options', { json: {} }).assertOk();
    const proven = await withPasskey.post('/office/two-factor-challenge/passkey', { json: { response: authenticator.authenticate(challenge.json() as never) } }).assertRedirect('/office');
    expect(proven.cookie(DEVICE)).toBeTruthy();

    // A passkey alone proves no password: this browser gets no cookie that keeps it signing in after the account's daily count is used up.
    const passwordless = browser();
    const options = await passwordless.post('/office/passkeys/sign-in/options', { json: {} }).assertOk();
    const signedIn = await passwordless.post('/office/passkeys/sign-in', { json: { response: authenticator.authenticate(options.json() as never) } }).assertRedirect('/office');
    signedIn.assertCookieMissing(DEVICE);
  });
});

describe('the sudo window with a passkey', () => {
  it('goes on to the secure page, not to the page of the app that was stored last', async () => {
    const editor = browser();
    await editorSignsIn(editor, eve);
    const authenticator = await enrol(editor);
    app.travel({ minutes: 20 });
    await editor.get('/dashboard').assertRedirect('/login');
    const options = await editor.post('/office/confirm-password/passkey/options', { json: {} }).assertOk();
    await editor.post('/office/confirm-password/passkey', { json: { response: authenticator.authenticate(options.json() as never) } }).assertRedirect('/office/secure');
  });
});

describe('the mails', () => {
  const sent = async () => {
    await app.queue.work();
    return app.mail.queued(OfficeSecurityMail).map((mail) => mail.message);
  };

  it('mail nobody for a payload of another guard, though the id is an editor’s: Eve has the id of Ada', async () => {
    const listener = app.make(NotifyEditorOfSignIn);
    const payload = { userId: eve.id, remember: false, via: 'attempt', at: new Date(app.clock.now()).toISOString(), ip: null, userAgent: null } as const;
    await listener.handle({ ...payload, guard: 'web' } as never);
    await listener.handle(payload as never);
    expect(await sent()).toEqual([]);
    await listener.handle({ ...payload, guard: OfficeGuard.name } as never);
    expect((await sent()).map((message) => message.to)).toEqual([[{ address: 'eve@office.example.com', name: 'Eve Editor' }]]);
  });

  it.each([
    ['operator', 'Two-factor authentication was removed by an operator'],
    ['reset', 'Two-factor authentication was reset'],
  ])('tells the editor about the %s’s removal of the second factors in its own words, to the editor’s address, whatever passkeys are left', async (via, subject) => {
    const editor = browser();
    await editorSignsIn(editor, eve);
    await enrol(editor);
    const listener = app.make(NotifyEditorOfTwoFactorDisabled);
    await listener.handle({ guard: OfficeGuard.name, userId: eve.id, via } as never);
    const messages = (await sent()).filter((message) => message.subject === subject);
    expect(messages.map((message) => message.to)).toEqual([[{ address: 'eve@office.example.com', name: 'Eve Editor' }]]);
    expect((await sent()).map((message) => message.subject)).not.toContain('The authenticator app was removed');
  });

  it('mails no sign-in while the sign-in only waits for its second factor, and one when it is done', async () => {
    const editor = browser();
    await editorSignsIn(editor, eve);
    const { secret } = await enable(editor);
    const before = (await sent()).length;
    const waiting = browser();
    await editorSignsIn(waiting, eve).assertRedirect('/office/two-factor-challenge');
    expect(await sent()).toHaveLength(before);
    await waiting.post('/office/two-factor-challenge', { form: { code: twoFactorCode(secret, inSeconds(30)) } }).assertRedirect('/office');
    const after = await sent();
    expect(after).toHaveLength(before + 1);
    expect(after.at(-1)!.subject).toBe('New sign-in to the back office');
  });

  it('escapes an editor’s name in the mail: no markup of it is in the message', async () => {
    await app.make(Connections).get().updateTable('office_users').set({ name: '<b>Eve</b> & <script>x</script>' }).where('id', '=', eve.id).execute();
    await editorSignsIn(browser(), eve).assertRedirect('/office');
    const [message] = await sent();
    expect(message!.html).toContain('&lt;b&gt;Eve&lt;/b&gt;');
    expect(message!.html).not.toContain('<b>Eve');
    expect(message!.html).not.toContain('<script>');
  });
});

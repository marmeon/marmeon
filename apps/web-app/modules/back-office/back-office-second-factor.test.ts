import { UserRepository, type User } from '#modules/auth';
import { OfficeSecurityMail, OfficeGuard, type OfficeUser } from '@fixtures/back-office';
import { softAuthenticator, twoFactorCode } from '@marmeon/auth/testing';
import { Connections } from '@marmeon/database';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { WARM_UP_TIMEOUT, warmUpDatabase } from '../auth/warm-up.ts';
import { NewSignInMail } from '../auth/mail/NewSignInMail.ts';

beforeAll(warmUpDatabase, WARM_UP_TIMEOUT);

// The second factors of the back office's own editors (the default mode): an authenticator app with recovery codes, passkeys, and the mails about both, on
// the guard's tables. The seeders give the editor Eve the id of the customer Ada and the viewer Victor the id of Alan: whatever an editor does with a
// factor must reach the editor's rows and never the customer's.
let app: TestApp;
let ada: User;
let eve: OfficeUser;
let victor: OfficeUser;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh', seed: true });
  [ada] = (await customers(app)) as [User];
  [eve, victor] = (await office(app)) as [OfficeUser, OfficeUser];
}, 30_000);
afterEach(() => app.close());

const customers = (target: TestApp): Promise<User[]> => target.make(UserRepository).query().selectAll().orderBy('id').execute();
const office = (target: TestApp) => target.make(Connections).get().selectFrom('office_users').select(['id', 'name', 'email', 'role']).orderBy('id').execute() as Promise<OfficeUser[]>;
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0';
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

/** A browser of its own: it keeps the cookies of its responses, as a person's does. */
const browser = (userAgent = FIREFOX) => app.keepingCookies().withHeaders({ 'user-agent': userAgent });
const editorSignsIn = (as: TestApp, who: { email: string }, password = 'password') => as.post('/office/login', { form: { email: who.email, password } });
const customerSignsIn = (as: TestApp, who: { email: string }) => as.post('/login', { form: { email: who.email, password: 'password' } });
const propsOf = async (as: TestApp, path: string) => (await as.navigating().get(path)).page()!.props as Record<string, any>;
const inSeconds = (seconds: number) => new Date(Date.now() + seconds * 1000);
/** The tests' APP_URL is http://localhost: that is the relying party. */
const device = () => softAuthenticator({ origin: 'http://localhost', rpId: 'localhost' });
const here = 'http://localhost/office/two-factor-challenge';
/** The answer is this status with exactly this JSON body. */
const answers = (response: { status: number; json(): unknown }, status: number, body: unknown) => {
  expect([response.status, response.json()]).toEqual([status, body]);
};
const WRONG_PASSWORD = { field: 'password', error: 'The password is not correct.' };
const FAILED = { error: 'That did not work.' };

/** Eve, signed in in `as`, turns the authenticator on as the security page does: begin, read the key, confirm with a code and the password. */
async function enable(as: TestApp, password = 'password') {
  await as.post('/office/security/two-factor/setup').assertRedirect('/office/security');
  const setup = (await propsOf(as, '/office/security')).setup as { secret: string; qr: { size: number; path: string } };
  const done = await as.layering().post('/office/security/two-factor/confirm', { form: { code: twoFactorCode(setup.secret), password } }).assertLayer('office::RecoveryCodes', { signedOut: true });
  return { secret: setup.secret, recoveryCodes: done.page()!.props.codes as string[] };
}

/** Eve, signed in in `as`, adds `authenticator` as a passkey, as the security page does: options, then the browser's answer with a name and the password. */
async function enrol(as: TestApp, authenticator = device(), name = 'Laptop') {
  const options = await as.post('/office/security/passkeys/options', { json: {} }).assertOk();
  const done = await as.post('/office/security/passkeys', { json: { response: authenticator.register(options.json() as never), name, password: 'password' } }).assertOk();
  return { authenticator, recoveryCodes: (done.json() as { recoveryCodes: string[] | null }).recoveryCodes };
}

describe('the authenticator app of an editor', () => {
  it('sets up: a key, a QR code, ten recovery codes shown once, and none of it on the page beneath', async () => {
    const editor = browser();
    await editorSignsIn(editor, eve).assertRedirect('/office');
    const { secret, recoveryCodes } = await enable(editor);
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(recoveryCodes).toHaveLength(10);
    const page = await propsOf(editor, '/office/security');
    expect(page).toMatchObject({ enabled: true, recoveryCodesLeft: 10, setup: null });
    expect(JSON.stringify(page)).not.toContain(secret);
    expect(JSON.stringify(page)).not.toContain(recoveryCodes[0]);
    // The rows are the guard's, for the editor, and the customer with the same id has none.
    const db = app.make(Connections).get<any>();
    expect(await db.selectFrom('office_two_factor_authentications').select('user_id').execute()).toEqual([{ user_id: eve.id }]);
    expect(await db.selectFrom('office_two_factor_recovery_codes').select('id').execute()).toHaveLength(10);
    expect(await db.selectFrom('two_factor_authentications').select('id').execute()).toEqual([]);
    expect(await db.selectFrom('two_factor_recovery_codes').select('id').execute()).toEqual([]);
    // A reload asks the answer's address with a GET: the security page, never the codes.
    await editor.get('/office/security/two-factor/confirm').assertRedirect('/office/security');
  });

  it('answers as a layer over the security page that is shown once, with ten codes, for the setup and for new codes alike', async () => {
    const editor = browser();
    await editorSignsIn(editor, eve);
    await editor.post('/office/security/two-factor/setup').assertRedirect('/office/security');
    const { secret } = (await propsOf(editor, '/office/security')).setup as { secret: string };
    const confirmed = await editor.layering().post('/office/security/two-factor/confirm', { form: { code: twoFactorCode(secret), password: 'password' } }).assertLayer('office::RecoveryCodes', { signedOut: true });
    expect(confirmed.page()!.layer).toEqual({ key: 'office.two-factor.codes', base: '/office/security', once: true });
    expect(confirmed.page()!.props.codes).toHaveLength(10);
    const fresh = await editor.layering().post('/office/security/two-factor/recovery-codes', { form: { password: 'password' } }).assertLayer('office::RecoveryCodes', { signedOut: false });
    expect(fresh.page()!.layer).toEqual({ key: 'office.two-factor.codes', base: '/office/security', once: true });
    expect(fresh.page()!.props.codes).toHaveLength(10);
  });

  it('asks for the code after the password: not signed in before it, a wrong code refused, the right one signs in', async () => {
    const editor = browser();
    await editorSignsIn(editor, eve);
    const { secret } = await enable(editor);
    await editor.post('/office/logout').assertRedirect('/office/login');

    const waiting = browser();
    await editorSignsIn(waiting, eve).assertRedirect('/office/two-factor-challenge').assertGuest({ guard: OfficeGuard });
    await waiting.navigating().get('/office/two-factor-challenge').assertOk().assertPage('office::Challenge', { step: 'sign-in', totp: true, passkey: false });
    await waiting.get('/office').assertRedirect('/office/login');
    await waiting
      .post('/office/two-factor-challenge', { form: { code: '000000' }, headers: { referer: here } })
      .assertRedirect('/office/two-factor-challenge')
      .assertInvalid({ code: 'That code did not work.' })
      .assertGuest({ guard: OfficeGuard });
    await waiting.get('/office').assertRedirect('/office/login');
    await waiting.post('/office/two-factor-challenge', { form: { code: twoFactorCode(secret, inSeconds(30)) } }).assertRedirect('/office').assertAuthenticated(eve, { guard: OfficeGuard });
    await waiting.navigating().get('/office').assertOk().assertPage('office::Overview', { name: 'Eve Editor' });
  });

  it('takes a recovery code once: the second use of it is refused', async () => {
    const editor = browser();
    await editorSignsIn(editor, eve);
    const { recoveryCodes } = await enable(editor);
    const first = browser();
    await editorSignsIn(first, eve).assertRedirect('/office/two-factor-challenge');
    await first.post('/office/two-factor-challenge', { form: { recovery_code: recoveryCodes[0]!.toLowerCase() } }).assertRedirect('/office').assertAuthenticated(eve, { guard: OfficeGuard });
    const second = browser();
    await editorSignsIn(second, eve).assertRedirect('/office/two-factor-challenge');
    await second
      .post('/office/two-factor-challenge', { form: { recovery_code: recoveryCodes[0]! }, headers: { referer: here } })
      .assertInvalid({ recovery_code: 'That recovery code did not work.' })
      .assertGuest({ guard: OfficeGuard });
    // Another code of the list still works.
    const third = browser();
    await editorSignsIn(third, eve);
    await third.post('/office/two-factor-challenge', { form: { recovery_code: recoveryCodes[1]! } }).assertRedirect('/office').assertAuthenticated(eve, { guard: OfficeGuard });
  });

  it('ends the wait after five wrong codes: the password is typed again', async () => {
    const editor = browser();
    await editorSignsIn(editor, eve);
    await enable(editor);
    const waiting = browser();
    await editorSignsIn(waiting, eve).assertRedirect('/office/two-factor-challenge');
    for (let wrong = 1; wrong <= 4; wrong++) await waiting.post('/office/two-factor-challenge', { form: { code: '000000' }, headers: { referer: here } }).assertInvalid(['code']);
    await waiting.post('/office/two-factor-challenge', { form: { code: '000000' }, headers: { referer: here } }).assertRedirect('/office/login');
    await waiting.get('/office/two-factor-challenge').assertRedirect('/office/login');
  });

  it('is the editor’s alone: the customer with the same id has no factor, and signs in with the password alone', async () => {
    const editor = browser();
    await editorSignsIn(editor, eve);
    await enable(editor);
    await customerSignsIn(browser(), ada).assertRedirect();
    // The second step of the guard is a guest page of the back office only, and nothing of the app's waits for a code.
    await app.get('/two-factor-challenge').assertRedirect('/login');
  });

  it('regenerates the recovery codes with the password typed now, and the old ones stop working', async () => {
    const editor = browser();
    await editorSignsIn(editor, eve);
    const { recoveryCodes } = await enable(editor);
    await editor.post('/office/security/two-factor/recovery-codes', { form: { password: 'wrong' }, headers: { referer: 'http://localhost/office/security' } }).assertInvalid({ password: 'The password is not correct.' });
    const fresh = await editor.layering().post('/office/security/two-factor/recovery-codes', { form: { password: 'password' } }).assertLayer('office::RecoveryCodes', { signedOut: false });
    const codes = fresh.page()!.props.codes as string[];
    expect(codes).toHaveLength(10);
    expect(codes).not.toContain(recoveryCodes[0]);
    const waiting = browser();
    await editorSignsIn(waiting, eve).assertRedirect('/office/two-factor-challenge');
    await waiting.post('/office/two-factor-challenge', { form: { recovery_code: recoveryCodes[0]! }, headers: { referer: here } }).assertInvalid(['recovery_code']);
    await waiting.post('/office/two-factor-challenge', { form: { recovery_code: codes[0]! } }).assertRedirect('/office').assertAuthenticated(eve, { guard: OfficeGuard });
  });

  it('turns off with the password, and the next sign-in asks for nothing more', async () => {
    const editor = browser();
    await editorSignsIn(editor, eve);
    await enable(editor);
    await editor.post('/office/security/two-factor/disable', { form: { password: 'wrong' }, headers: { referer: 'http://localhost/office/security' } }).assertInvalid({ password: 'The password is not correct.' });
    expect(await propsOf(editor, '/office/security')).toMatchObject({ enabled: true });
    await editor.post('/office/security/two-factor/disable', { form: { password: 'password' } }).assertRedirect('/office/security');
    expect(await propsOf(editor, '/office/security')).toMatchObject({ enabled: false, secured: false });
    await editorSignsIn(browser(), eve).assertRedirect('/office').assertAuthenticated(eve, { guard: OfficeGuard });
  });

  it('asks for a factor again on the security page once the proof is older than 15 minutes', async () => {
    const editor = browser();
    await editorSignsIn(editor, eve);
    await enable(editor);
    await editor.navigating().get('/office/security').assertOk().assertPage('office::Security');
    app.travel({ minutes: 20 });
    // The sudo window has closed too: the password comes first, then the factor.
    await editor.get('/office/security').assertRedirect('/office/confirm-password');
    await editor.post('/office/confirm-password', { form: { password: 'password' } }).assertRedirect();
    await editor.get('/office/security').assertRedirect('/office/two-factor-verify');
    await editor.post('/office/security/two-factor/disable', { form: { password: 'password' } }).assertRedirect('/office/two-factor-verify');
    await editor.navigating().get('/office/two-factor-verify').assertOk().assertPage('office::Challenge', { step: 'verify', totp: true });
    await editor.post('/office/two-factor-verify', { form: { code: '000000' }, headers: { referer: 'http://localhost/office/two-factor-verify' } }).assertInvalid({ code: 'That code did not work.' });
    await editor.get('/office/security').assertRedirect('/office/two-factor-verify');
  });

  it('checks the code and the password of the setup before it turns anything on', async () => {
    const editor = browser();
    await editorSignsIn(editor, eve);
    await editor.post('/office/security/two-factor/setup').assertRedirect('/office/security');
    const { secret } = (await propsOf(editor, '/office/security')).setup as { secret: string };
    await editor.post('/office/security/two-factor/confirm', { form: { code: twoFactorCode(secret), password: 'wrong' }, headers: { referer: 'http://localhost/office/security' } }).assertInvalid({ password: 'The password is not correct.' });
    await editor.post('/office/security/two-factor/confirm', { form: { code: '000000', password: 'password' }, headers: { referer: 'http://localhost/office/security' } }).assertInvalid({ code: 'That code did not work.' });
    expect(await app.make(Connections).get<any>().selectFrom('office_two_factor_recovery_codes').select('id').execute()).toEqual([]);
    await editorSignsIn(browser(), eve).assertRedirect('/office');
  });

  it('keeps every page of the factors for the signed-in editor and the guard’s own session: a guest and a customer are sent to the sign-in', async () => {
    const customer = app.actingAs(ada);
    for (const path of ['/office/security', '/office/two-factor-verify', '/office/security/two-factor/confirm']) {
      await app.get(path).assertRedirect('/office/login');
      await customer.get(path).assertRedirect('/office/login');
    }
    for (const path of ['/office/security/two-factor/setup', '/office/security/two-factor/disable', '/office/security/two-factor/recovery-codes', '/office/security/passkeys/options', '/office/security/passkeys']) {
      await app.post(path, { form: {} }).assertRedirect('/office/login');
      await customer.post(path, { form: {} }).assertRedirect('/office/login');
    }
  });
});

describe('the passkeys of an editor', () => {
  it('adds one with the password, lists it, and signs in with it alone', async () => {
    const editor = browser();
    await editorSignsIn(editor, eve);
    const { authenticator, recoveryCodes } = await enrol(editor);
    // The first factor makes the recovery codes, once.
    expect(recoveryCodes).toHaveLength(10);
    const db = app.make(Connections).get<any>();
    expect(await db.selectFrom('office_passkeys').select('user_id').execute()).toEqual([{ user_id: eve.id }]);
    expect(await db.selectFrom('passkeys').select('id').execute()).toEqual([]);
    expect(await propsOf(editor, '/office/security')).toMatchObject({ enabled: false, secured: true, passkeys: [{ name: 'Laptop', suspended: false }], lastFactor: true });
    await editor.post('/office/logout').assertRedirect('/office/login');

    const guest = browser();
    const options = await guest.post('/office/passkeys/sign-in/options', { json: {} }).assertOk();
    await guest.post('/office/passkeys/sign-in', { json: { response: authenticator.authenticate(options.json() as never) } }).assertRedirect('/office').assertAuthenticated(eve, { guard: OfficeGuard });
    await guest.navigating().get('/office').assertOk().assertPage('office::Overview', { name: 'Eve Editor' });
  });

  it('asks the password for the passkey, and for no new one without it', async () => {
    const editor = browser();
    await editorSignsIn(editor, eve);
    const options = await editor.post('/office/security/passkeys/options', { json: {} }).assertOk();
    const response = device().register(options.json() as never);
    answers(await editor.post('/office/security/passkeys', { json: { response, name: 'Laptop', password: 'wrong' } }), 422, WRONG_PASSWORD);
    const missing = await editor.expectingJson().post('/office/security/passkeys', { json: { response, name: 'Laptop' } });
    expect(missing.status).toBe(422);
    expect(Object.keys((missing.json() as { errors: object }).errors)).toEqual(['password']);
    expect(await app.make(Connections).get<any>().selectFrom('office_passkeys').select('id').execute()).toEqual([]);
  });

  it('refuses the editor’s passkey at the app’s sign-in, and the customer’s at the back office’s, with the answer of an unknown passkey', async () => {
    const editor = browser();
    await editorSignsIn(editor, eve);
    const { authenticator: eves } = await enrol(editor);
    // Ada registers a passkey of her own at the app.
    const customer = browser();
    await customerSignsIn(customer, ada).assertRedirect();
    const adas = device();
    const registration = await customer.post('/settings/passkeys/options', { json: {} }).assertOk();
    await customer.post('/settings/passkeys', { json: { response: adas.register(registration.json() as never), name: 'Phone', password: 'password' } }).assertOk();

    // Every attempt takes fresh options (a failed answer spends the challenge), and a passkey nobody registered is the reference for "refused alike".
    const nobodys = () => {
      const stranger = device();
      stranger.register({ challenge: 'AAAA', user: { id: 'AAAA' } });
      return stranger;
    };
    const attempt = async (as: TestApp, base: string, authenticator: ReturnType<typeof device>) => {
      const options = await as.post(`${base}/options`, { json: {} }).assertOk();
      return as.post(base, { json: { response: authenticator.authenticate(options.json() as never) } });
    };
    // The app's sign-in refuses Eve's passkey with the body it gives a passkey nobody registered.
    const atApp = browser();
    const refusedAtApp = await attempt(atApp, '/passkeys/sign-in', eves).then((response) => response.assertGuest());
    const unknownAtApp = await attempt(atApp, '/passkeys/sign-in', nobodys());
    expect([refusedAtApp.status, refusedAtApp.json()]).toEqual([422, { error: expect.any(String) }]);
    expect([unknownAtApp.status, unknownAtApp.json()]).toEqual([refusedAtApp.status, refusedAtApp.json()]);
    // The back office refuses Ada's passkey, though Eve has the id of Ada, with the body it gives a passkey nobody registered.
    const atOffice = browser();
    const refusedAtOffice = await attempt(atOffice, '/office/passkeys/sign-in', adas).then((response) => response.assertGuest({ guard: OfficeGuard }));
    answers(refusedAtOffice, 422, FAILED);
    answers(await attempt(atOffice, '/office/passkeys/sign-in', nobodys()), 422, FAILED);
    await atOffice.get('/office').assertRedirect('/office/login');
    // Each still signs in at its own place.
    const again = await atOffice.post('/office/passkeys/sign-in/options', { json: {} }).assertOk();
    await atOffice.post('/office/passkeys/sign-in', { json: { response: eves.authenticate(again.json() as never) } }).assertRedirect('/office').assertAuthenticated(eve, { guard: OfficeGuard });
    const adaAgain = await atApp.post('/passkeys/sign-in/options', { json: {} }).assertOk();
    await atApp.post('/passkeys/sign-in', { json: { response: adas.authenticate(adaAgain.json() as never) } }).assertRedirect().assertAuthenticated(ada);
  });

  it('opens the sudo window with a passkey in place of the password', async () => {
    const editor = browser();
    await editorSignsIn(editor, eve);
    const { authenticator } = await enrol(editor);
    app.travel({ minutes: 20 });
    await editor.get('/office/secure').assertRedirect('/office/confirm-password');
    const options = await editor.post('/office/confirm-password/passkey/options', { json: {} }).assertOk();
    await editor.post('/office/confirm-password/passkey', { json: { response: authenticator.authenticate(options.json() as never) } }).assertRedirect('/office/secure');
    await editor.navigating().get('/office/secure').assertOk().assertPage('office::Secure');
    // The window is the guard's and runs out like the password's.
    app.travel({ minutes: 20 });
    await editor.get('/office/secure').assertRedirect('/office/confirm-password');
  });

  it('refuses another passkey in the sudo confirmation, with the answer for every failure', async () => {
    const editor = browser();
    await editorSignsIn(editor, eve);
    await enrol(editor);
    // Victor has no passkey yet: he has none to offer. Then he adds one, and answers a challenge that Eve's options opened with it.
    const viewer = browser();
    await editorSignsIn(viewer, victor);
    answers(await viewer.post('/office/confirm-password/passkey/options', { json: {} }), 422, FAILED);
    const { authenticator: victors } = await enrol(viewer);
    app.travel({ minutes: 20 });
    const options = await editor.post('/office/confirm-password/passkey/options', { json: {} }).assertOk();
    answers(await editor.post('/office/confirm-password/passkey', { json: { response: victors.authenticate({ challenge: (options.json() as { challenge: string }).challenge }) } }), 422, FAILED);
    await editor.get('/office/secure').assertRedirect('/office/confirm-password');
  });

  it('asks for the passkey after the password when the editor has a passkey and no authenticator app', async () => {
    const editor = browser();
    await editorSignsIn(editor, eve);
    const { authenticator, recoveryCodes } = await enrol(editor);
    await editor.post('/office/logout');
    const waiting = browser();
    await editorSignsIn(waiting, eve).assertRedirect('/office/two-factor-challenge').assertGuest({ guard: OfficeGuard });
    await waiting.navigating().get('/office/two-factor-challenge').assertOk().assertPage('office::Challenge', { step: 'sign-in', totp: false, passkey: true });
    const options = await waiting.post('/office/two-factor-challenge/passkey/options', { json: {} }).assertOk();
    await waiting.post('/office/two-factor-challenge/passkey', { json: { response: authenticator.authenticate(options.json() as never) } }).assertRedirect('/office').assertAuthenticated(eve, { guard: OfficeGuard });
    // A recovery code is the way in too.
    const lost = browser();
    await editorSignsIn(lost, eve);
    await lost.post('/office/two-factor-challenge', { form: { recovery_code: recoveryCodes![0]! } }).assertRedirect('/office').assertAuthenticated(eve, { guard: OfficeGuard });
  });

  it('takes the page the guest wanted at the passkey sign-in, at the passkey as second step, at the sudo page and at the step-up', async () => {
    const editor = browser();
    await editorSignsIn(editor, eve);
    const { authenticator } = await enrol(editor);
    await editor.post('/office/logout');

    // The passkey sign-in alone.
    const alone = browser();
    await alone.get('/office/sessions').assertRedirect('/office/login');
    const signInOptions = await alone.post('/office/passkeys/sign-in/options', { json: {} }).assertOk();
    await alone.post('/office/passkeys/sign-in', { json: { response: authenticator.authenticate(signInOptions.json() as never) } }).assertRedirect('/office/sessions').assertAuthenticated(eve, { guard: OfficeGuard });

    // The passkey as the second step after the password.
    const waiting = browser();
    await waiting.get('/office/sessions').assertRedirect('/office/login');
    await editorSignsIn(waiting, eve).assertRedirect('/office/two-factor-challenge');
    const challengeOptions = await waiting.post('/office/two-factor-challenge/passkey/options', { json: {} }).assertOk();
    await waiting.post('/office/two-factor-challenge/passkey', { json: { response: authenticator.authenticate(challengeOptions.json() as never) } }).assertRedirect('/office/sessions');

    // The passkey at the sudo page: the wished page differs from the page the controller falls back to.
    app.travel({ minutes: 20 });
    await alone.get('/office/secure?from=wish').assertRedirect('/office/confirm-password');
    const confirmOptions = await alone.post('/office/confirm-password/passkey/options', { json: {} }).assertOk();
    await alone.post('/office/confirm-password/passkey', { json: { response: authenticator.authenticate(confirmOptions.json() as never) } }).assertRedirect('/office/secure?from=wish');

    // The passkey as the step-up: the password was typed, the factor is older than the window.
    app.travel({ minutes: 20 });
    await alone.post('/office/confirm-password', { form: { password: 'password' } }).assertRedirect('/office/secure');
    await alone.get('/office/security?from=wish').assertRedirect('/office/two-factor-verify');
    const stepOptions = await alone.post('/office/two-factor-verify/passkey/options', { json: {} }).assertOk();
    await alone.post('/office/two-factor-verify/passkey', { json: { response: authenticator.authenticate(stepOptions.json() as never) } }).assertRedirect('/office/security?from=wish');
  });

  it('removes a passkey with the password, and the last factor takes the recovery codes along', async () => {
    const editor = browser();
    await editorSignsIn(editor, eve);
    await enrol(editor);
    const db = app.make(Connections).get<any>();
    const [{ id }] = (await db.selectFrom('office_passkeys').select('id').execute()) as [{ id: number }];
    answers(await editor.post(`/office/security/passkeys/${id}/remove`, { json: { password: 'wrong' } }), 422, WRONG_PASSWORD);
    expect(await db.selectFrom('office_passkeys').select('id').execute()).toHaveLength(1);
    await editor.post(`/office/security/passkeys/${id}/remove`, { json: { password: 'password' } }).assertOk();
    expect(await db.selectFrom('office_passkeys').select('id').execute()).toEqual([]);
    expect(await db.selectFrom('office_two_factor_recovery_codes').select('id').execute()).toEqual([]);
    await editor.post('/office/security/passkeys/999999/remove', { json: { password: 'password' } }).assertNotFound();
  });

  it('never removes a passkey of the customer with the same id: another editor’s and the app’s are an unknown id', async () => {
    // Victor (the id of Alan) has a passkey; Eve asks to remove it.
    const viewer = browser();
    await editorSignsIn(viewer, victor);
    await enrol(viewer);
    const editor = browser();
    await editorSignsIn(editor, eve);
    const [{ id }] = (await app.make(Connections).get<any>().selectFrom('office_passkeys').select('id').execute()) as [{ id: number }];
    await editor.post(`/office/security/passkeys/${id}/remove`, { json: { password: 'password' } }).assertNotFound();
    expect(await app.make(Connections).get<any>().selectFrom('office_passkeys').select('id').execute()).toHaveLength(1);
  });
});

describe('the mails about an editor’s sign-ins and factors', () => {
  const sent = async () => {
    await app.queue.work();
    return app.mail.queued(OfficeSecurityMail).map((mail) => mail.message);
  };
  /** What the app does for its own users' sign-ins: a notification row and a queued mail. Nothing of it may happen for what the guard did. */
  const appNotices = async () => {
    await app.queue.work();
    return { mails: app.mail.queued(NewSignInMail).length, rows: (await app.make(Connections).get<any>().selectFrom('notifications').select('id').execute()).length };
  };

  it('mails a new sign-in to the editor’s own address, never to the customer with the same id', async () => {
    expect(eve.id).toBe(ada.id);
    await editorSignsIn(browser(), eve).assertRedirect('/office');
    const messages = await sent();
    expect(messages.map((message) => [message.subject, message.to])).toEqual([['New sign-in to the back office', [{ address: 'eve@office.example.com', name: 'Eve Editor' }]]]);
    expect(messages[0]!.text).toContain('Hello Eve Editor');
    // Nothing for Ada: not a mail of the package, and none of the app's.
    const addresses = app.mail.queued(OfficeSecurityMail).flatMap((mail) => mail.message.to.map((to) => to.address));
    expect(addresses).not.toContain(ada.email);
    expect(await appNotices()).toEqual({ mails: 0, rows: 0 });
  });

  it('mails the customer’s own sign-in to nobody of the back office, and an editor’s failed sign-in to nobody', async () => {
    await customerSignsIn(browser(), ada).assertRedirect();
    await editorSignsIn(browser(), eve, 'wrong').assertInvalid(['email']);
    expect(await sent()).toEqual([]);
  });

  it('mails turning the factors on and off and a new passkey to the editor’s address', async () => {
    const editor = browser();
    await editorSignsIn(editor, victor);
    await enable(editor);
    await enrol(editor);
    await editor.post('/office/security/two-factor/disable', { form: { password: 'password' } }).assertRedirect('/office/security');
    const messages = await sent();
    expect(messages.map((message) => message.subject).sort()).toEqual(['A passkey was added', 'New sign-in to the back office', 'The authenticator app was removed', 'Two-factor authentication is on']);
    for (const message of messages) expect(message.to).toEqual([{ address: 'victor@office.example.com', name: 'Victor Viewer' }]);
    // Victor has the id of Alan, who is a customer with an address of his own: he got none.
    const alan = (await customers(app))[1]!;
    expect(victor.id).toBe(alan.id);
    expect(app.mail.queued(OfficeSecurityMail).flatMap((mail) => mail.message.to.map((to) => to.address))).not.toContain(alan.email);
    expect(await appNotices()).toEqual({ mails: 0, rows: 0 });
  });

  it('says that only the authenticator app went while a passkey is left, and that the factor is off when none is', async () => {
    const editor = browser();
    await editorSignsIn(editor, eve);
    await enable(editor);
    await editor.post('/office/security/two-factor/disable', { form: { password: 'password' } }).assertRedirect('/office/security');
    expect((await sent()).map((message) => message.subject)).toContain('Two-factor authentication is off');
    expect((await sent()).map((message) => message.subject)).not.toContain('The authenticator app was removed');
    const kept = (await sent()).length;
    await enable(editor);
    await enrol(editor);
    await editor.post('/office/security/two-factor/disable', { form: { password: 'password' } }).assertRedirect('/office/security');
    const last = (await sent()).at(-1)!;
    expect(last.subject).toBe('The authenticator app was removed');
    expect(last.text).toContain('Your passkeys still protect it');
    expect((await sent()).length).toBeGreaterThan(kept);
  });

  it('mails nothing for an editor who is gone by the time the job runs', async () => {
    await editorSignsIn(browser(), eve).assertRedirect('/office');
    await app.make(Connections).get().deleteFrom('office_users').where('id', '=', eve.id).execute();
    expect(await sent()).toEqual([]);
    // The job found nobody and ended: it is neither waiting for a retry nor failed.
    expect(app.queue.pending()).toEqual([]);
    expect(await app.queue.failed()).toEqual([]);
  });
});

describe('the shared browser session', () => {
  it('signs the customer out of the app too when an editor’s sign-in is ended, because the browser has one session', async () => {
    const phone = browser(SAFARI);
    await editorSignsIn(phone, eve).assertRedirect('/office');
    await customerSignsIn(phone, ada).assertRedirect();
    await phone.get('/dashboard').assertOk();
    const laptop = browser(FIREFOX);
    await editorSignsIn(laptop, eve).assertRedirect('/office');
    const list = (await propsOf(laptop, '/office/sessions')).signIns as { id: string; current: boolean }[];
    await laptop.post(`/office/sessions/${list.find((row) => !row.current)!.id}/end`).assertRedirect('/office/sessions');
    // The ended sign-in ended the phone's browser session: the editor and the customer in it are both signed out. Fail safe, and documented.
    await phone.get('/office').assertRedirect('/office/login');
    await phone.get('/dashboard').assertRedirect('/login');
  });
});

describe('the waiting sign-in', () => {
  it('keeps the guard’s waiting sign-in out of the app: the app’s challenge finds nothing to finish', async () => {
    const editor = browser();
    await editorSignsIn(editor, eve);
    const { secret } = await enable(editor);
    const waiting = browser();
    await editorSignsIn(waiting, eve).assertRedirect('/office/two-factor-challenge');
    // The app's page and post for the second step belong to its own sign-in, which nobody started.
    await waiting.get('/two-factor-challenge').assertRedirect('/login');
    await waiting.post('/two-factor-challenge', { form: { code: twoFactorCode(secret, inSeconds(30)) }, headers: { referer: 'http://localhost/two-factor-challenge' } }).assertRedirect('/login').assertGuest();
    await waiting.get('/office').assertRedirect('/office/login');
  });
  it('goes on to the overview, not to the page a customer wanted before: the stored page of the app is no page of the back office', async () => {
    const enrolling = browser();
    await editorSignsIn(enrolling, eve);
    const { secret, recoveryCodes } = await enable(enrolling);
    const { authenticator } = await enrol(enrolling);
    await enrolling.post('/office/logout');

    // A guest asks for a page of the app, which the session keeps as the page to go back to; then an editor finishes the second step.
    const withCode = browser();
    await withCode.get('/dashboard').assertRedirect('/login');
    await editorSignsIn(withCode, eve).assertRedirect('/office/two-factor-challenge');
    await withCode.post('/office/two-factor-challenge', { form: { code: twoFactorCode(secret, inSeconds(30)) } }).assertRedirect('/office');

    const withPasskey = browser();
    await withPasskey.get('/dashboard').assertRedirect('/login');
    await editorSignsIn(withPasskey, eve).assertRedirect('/office/two-factor-challenge');
    const challenge = await withPasskey.post('/office/two-factor-challenge/passkey/options', { json: {} }).assertOk();
    await withPasskey.post('/office/two-factor-challenge/passkey', { json: { response: authenticator.authenticate(challenge.json() as never) } }).assertRedirect('/office');

    const passwordless = browser();
    await passwordless.get('/dashboard').assertRedirect('/login');
    const options = await passwordless.post('/office/passkeys/sign-in/options', { json: {} }).assertOk();
    await passwordless.post('/office/passkeys/sign-in', { json: { response: authenticator.authenticate(options.json() as never) } }).assertRedirect('/office');

    // A page of the back office that a guest wanted is followed.
    const wanted = browser();
    await wanted.get('/office/sessions').assertRedirect('/office/login');
    await editorSignsIn(wanted, eve).assertRedirect('/office/two-factor-challenge');
    await wanted.post('/office/two-factor-challenge', { form: { recovery_code: recoveryCodes[0]! } }).assertRedirect('/office/sessions');
  });
});

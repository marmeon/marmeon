import { softAuthenticator, twoFactorCode, cookieNames } from '@marmeon/auth/testing';
import { Connections } from '@marmeon/database';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { afterEach, beforeAll, beforeEach, describe, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from './factories/UserFactory.ts';
import { ResetPasswordMail } from './mail/ResetPasswordMail.ts';
import type { User } from './users.ts';
import { WARM_UP_TIMEOUT, warmUp } from './warm-up.ts';

beforeAll(warmUp, WARM_UP_TIMEOUT);

// An address nobody confirmed owns no second factor and no passkey: whoever signed up with somebody else's
// address (open registration) cannot attach a way in of their own, and a reset by the owner removes whatever such an account holds anyway.

let app: TestApp;
let SESSION: string;
afterEach(() => app.close());

const credentialsOf = (user: User) => ({ form: { email: user.email, password: 'password' } });
const device = () => softAuthenticator({ origin: 'http://localhost', rpId: 'localhost' });
const FACTOR_TABLES = ['passkeys', 'two_factor_authentications', 'two_factor_recovery_codes', 'personal_access_tokens'] as const;

describe('an unconfirmed address with AUTH_PRIVATE_REGISTRATION=false', { timeout: 30_000 }, () => {
  beforeEach(async () => {
    app = await createTestApp(application, { database: 'refresh', env: { AUTH_PRIVATE_REGISTRATION: 'false' } });
    ({ session: SESSION } = cookieNames(app));
  }, 30_000);

  it('refuses an authenticator and a passkey before the address is confirmed, and stores nothing', async () => {
    const squatter = await app.factory(UserFactory).create({ email_verified_at: null, first_verified_at: null });
    const cookie = (await app.post('/login', credentialsOf(squatter)).assertStatus(303)).cookie(SESSION)!;
    const session = () => app.withCookie(SESSION, cookie);

    await session().post('/settings/two-factor/setup').assertRedirect('/email/verify');
    await session().post('/settings/tokens', { form: { current_password: 'password', name: 'CI', abilities: 'users:read' } }).assertRedirect('/email/verify');
    await session().post('/settings/two-factor/confirm', { form: { code: twoFactorCode('A'.repeat(32)), password: 'password' } }).assertRedirect('/email/verify');
    await session().post('/settings/passkeys/options', { json: {} }).assertStatus(302);
    await session().expectingJson().post('/settings/passkeys/options', { json: {} }).assertForbidden();
    await session()
      .expectingJson()
      .post('/settings/passkeys', { json: { response: device().register({ challenge: 'x', rp: { id: 'localhost', name: 'x' }, user: { id: 'x', name: 'x', displayName: 'x' }, pubKeyCredParams: [] } as never), name: 'Mine', password: 'password' } })
      .assertForbidden();

    for (const table of FACTOR_TABLES) await app.assertDatabaseCount(table, 0);
  });

  it('lets the same account add them once the address is confirmed', async () => {
    const ada = await app.factory(UserFactory).create();
    const cookie = (await app.post('/login', credentialsOf(ada)).assertStatus(303)).cookie(SESSION)!;
    await app.withCookie(SESSION, cookie).post('/settings/two-factor/setup').assertRedirect('/settings/two-factor');
    await app.assertDatabaseCount('two_factor_authentications', 1);
  });
});

describe('the reset of an account whose address was never confirmed', { timeout: 30_000 }, () => {
  beforeEach(async () => {
    app = await createTestApp(application, { database: 'refresh' });
    ({ session: SESSION } = cookieNames(app));
  }, 30_000);

  /** The account gets a passkey, an authenticator, recovery codes and an API token — as the squatter could before the address had to be confirmed. */
  async function holdingEverything(user: User) {
    const authenticator = device();
    const cookie = (await app.post('/login', credentialsOf(user)).assertStatus(303)).cookie(SESSION)!;
    const session = () => app.withCookie(SESSION, cookie);
    await session().post('/settings/tokens', { form: { current_password: 'password', name: 'CI', abilities: 'users:read' } });
    await session().post('/settings/two-factor/setup');
    const page = await session().navigating().get('/settings/two-factor').assertPage('auth/TwoFactor');
    const setup = page.page()!.props.setup as { secret: string };
    const confirmed = await session().layering().post('/settings/two-factor/confirm', { form: { code: twoFactorCode(setup.secret), password: 'password' } }).assertLayer('auth/RecoveryCodes');
    // Confirming the authenticator signed the other sessions out and proved the factor in this one.
    const proven = app.withCookie(SESSION, confirmed.cookie(SESSION) ?? cookie);
    const options = await proven.post('/settings/passkeys/options', { json: {} }).assertOk();
    await proven.post('/settings/passkeys', { json: { response: authenticator.register(options.json() as never), name: 'Squatter', password: 'password' } }).assertOk();
    await app.assertDatabaseCount('passkeys', 1);
    await app.assertDatabaseCount('two_factor_authentications', 1);
    await app.assertDatabaseCount('personal_access_tokens', 1);
    return { authenticator };
  }

  async function reset(user: User) {
    await app.post('/forgot-password', { form: { email: user.email } });
    await app.queue.work();
    const link = new URL(/https?:\/\/\S+\/reset-password\S*(?=\))/.exec(app.mail.queued(ResetPasswordMail).at(-1)!.message.text)![0]);
    const opened = await app.get(link.pathname + link.search).assertRedirect('/reset-password');
    await app.withCookie('password_reset', opened.cookie('password_reset')!).post('/reset-password', { form: { password: 'a new password', password_confirmation: 'a new password' } }).assertRedirect('/login');
  }

  it('removes the passkeys, the authenticator, the recovery codes and the API tokens', async () => {
    const owner = await app.factory(UserFactory).create();
    const { authenticator } = await holdingEverything(owner);
    await app.make(Connections).get<any>().updateTable('users').set({ email_verified_at: null, first_verified_at: null }).where('id', '=', owner.id).execute();

    await reset(owner);

    for (const table of FACTOR_TABLES) await app.assertDatabaseCount(table, 0);
    // The squatter's passwordless sign-in has nothing left to use.
    const options = await app.post('/passkeys/sign-in/options', { json: {} }).assertOk();
    await app.withCookie(SESSION, options.cookie(SESSION)!).post('/passkeys/sign-in', { json: { response: authenticator.authenticate(options.json() as never) } }).assertStatus(422);
  });

  it('leaves a confirmed account as it is', async () => {
    const owner = await app.factory(UserFactory).create();
    await holdingEverything(owner);

    await reset(owner);

    await app.assertDatabaseCount('passkeys', 1);
    await app.assertDatabaseCount('two_factor_authentications', 1);
    await app.assertDatabaseCount('personal_access_tokens', 1);
  });

  it('keeps the factors of an account that was confirmed once and then changed its address', async () => {
    const owner = await app.factory(UserFactory).create();
    await holdingEverything(owner);
    // The address changed and is not confirmed yet (`first_verified_at` stays): a reset must not wipe what the owner set up.
    await app.make(Connections).get<any>().updateTable('users').set({ email_verified_at: null }).where('id', '=', owner.id).execute();

    await reset(owner);

    await app.assertDatabaseCount('passkeys', 1);
    await app.assertDatabaseCount('two_factor_authentications', 1);
    await app.assertDatabaseCount('personal_access_tokens', 1);
  });
});

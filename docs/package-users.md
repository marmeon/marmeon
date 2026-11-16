# Packages with Users of Their Own

## Introduction

A package whose users are not the app's, such as a back office for editors, brings a guard of its own: its own table, its own sign-ins, its own second factors and passkeys, its own sudo mode and its own limits. The back office of the web app is such a package. Its source is `fixtures/back-office` in the framework's repository, and the code below is taken from it with the package's name written as `@acme/back-office`. It shows the case of a website with a customer portal in one app: the app's users are the customers of the portal, and the back office is for the editors, who are other people with a table of their own. [When to use a second guard](authentication.md#when-to-use-a-second-guard) says when a package should go this way.

The package runs in one of two modes, which the app chooses at boot with `BACK_OFFICE_USERS`:

| Mode | The back office's users | What the package brings |
|---|---|---|
| `own` (the default) | The editors in the table `office_users`. | The guard `office`, its sign-in with an authenticator app, recovery codes and passkeys, sign-out, list of sign-ins and sudo mode, and its limits. |
| `app` | The app's users, the customers of the portal. | Nothing to sign in to: the routes of the guard answer 404, people sign in to the app with the app's own second factors, and the app says which of them are editors. |

The package writes its policy, its overview and its routes once. A guard slot makes them follow the mode ([using the app's users instead](authentication.md#using-the-apps-users-instead)). The routes, the guard and its tables are the same in both modes, so the app's route list and its readiness never depend on `BACK_OFFICE_USERS`. An installation that has data does not switch from one mode to the other: the two modes are two sets of accounts, and an id means another person in each.

## The guard, the slot and the tables

The guard is defined once, and the slot beside it names "the editors, whoever they are":

```ts title="src/guard.ts"
import { defineGuard, defineGuardSlot, type GuardAccountSessions, type GuardAuth, type GuardPasskeys, type GuardTwoFactor } from '@marmeon/auth';
import { Passkeys } from '@marmeon/auth/passkeys';
import { TwoFactor } from '@marmeon/auth/two-factor';
import { OfficeUserRepository } from './OfficeUserRepository.ts';
import type { EditorUser, OfficeUser } from './OfficeUser.ts';

/**
 * The guard of the back office's own editors: their table `office_users`, their sign-ins in `office_sign_ins`, an authenticator app with recovery codes
 * (`office_two_factor_*`) and passkeys (`office_passkeys`), a working day of eight hours and no "keep me signed in".
 */
export const OfficeGuard = defineGuard('office', {
  users: OfficeUserRepository,
  tablePrefix: 'office_',
  twoFactor: TwoFactor,
  passkeys: Passkeys,
  settings: { sessionMaxHours: 8, rememberDays: 0, twoFactorIssuer: 'Back Office' },
});

// A type alias and a constant of the same name: a controller takes `auth: OfficeAuth`, and the container finds the guard's service.
export type OfficeAuth = GuardAuth<OfficeUser>;
export const OfficeAuth = OfficeGuard.Auth;
export type OfficeAccountSessions = GuardAccountSessions<OfficeUser>;
export const OfficeAccountSessions = OfficeGuard.AccountSessions;
export type OfficeTwoFactor = GuardTwoFactor<OfficeUser>;
export const OfficeTwoFactor = OfficeGuard.TwoFactor;
export type OfficePasskeys = GuardPasskeys<OfficeUser, Passkeys>;
export const OfficePasskeys = OfficeGuard.Passkeys;

/**
 * The editors, whoever they are: the guard's users in the own mode, the app's users in the other. The back office's policy and overview name the slot.
 * It has no `twoFactor` option, so it forwards no `twoFactor()` middleware: that one would force every editor to set up a factor. Neither mode does. An editor
 * with a factor is asked for it at the guard's sign-in, and an app user at the app's. The package's `confirmedSecondFactor()` is the guard's own, since those
 * routes exist in the mode `own` only, and it demands nothing of an editor who has no factor.
 */
export const EditorSlot = defineGuardSlot<EditorUser>('editor');
```

The guard has `twoFactor: TwoFactor` and `passkeys: Passkeys`, so its editors can use an authenticator app, recovery codes and passkeys on tables of the guard's own ([two factors and passkeys](#two-factors-and-passkeys) below). `GuardTwoFactor<OfficeUser>` and `GuardPasskeys<OfficeUser, Passkeys>` name the guard's services for a controller. The slot has no `twoFactor` option. With it the slot would forward `EditorSlot.twoFactor()`, which sends every editor without a factor to set one up, and neither mode forces that. `confirmedSecondFactor()` demands nothing of an editor who has no factor, and the package uses the guard's own because those routes exist in the mode `own` only. An editor who has a factor is asked for it at the guard's sign-in in the mode `own`, and a customer who has one at the app's sign-in in the mode `app`, where the slot is bound to `'web'`. A package that wants to demand a factor defines its slot with `defineGuardSlot<EditorUser>('editor', { twoFactor: true })` ([guard slots](authentication.md#using-the-apps-users-instead)).

The class `OfficeUserRepository` implements `UserProvider` on the table `office_users`: it takes `Connections`, reads the password hash and the session key with `secret()` next to the user, and leaves the writes of the hash and the key to `credentialWriter()` with `{ table: 'office_users' }` ([for your own user provider](authentication.md#for-your-own-user-provider)). A package names its user type, `credentialWriter<OfficeUser>(db, { table: 'office_users' })`, because the writer is otherwise typed by the app's user. It never reads the app's `users`.

The package ships five migrations as stubs in `stubs/migrations`: `office_users` (the editors, with the `password` and `session_key` as `secret()` columns, and a `role` that is `viewer` unless set), the two tables of the guard, `office_sign_ins` and `office_password_reset_tokens`, with the columns [the tables of a guard](authentication.md#the-tables) list, and the tables of the second factors and passkeys, `office_two_factor_authentications`, `office_two_factor_recovery_codes` and `office_passkeys`, with the shape of [the app's tables](two-factor-authentication.md#for-a-guard-of-a-package) under the guard's prefix. A stub that has shipped is never changed: a package adds a stub that sorts after the last one. The provider declares them with `static migrations` (the module it proposes is `back-office`), and the app takes them over:

```sh
marmeon publish @acme/back-office
marmeon migrate
```

`marmeon publish --check @acme/back-office` ends with exit code 0 once every migration is in the app. `/up/ready` is red until all six tables have every column the package reads, in both modes: the guard is registered in both, and so is the requirement for `office_users`.

## The provider and its two modes

The provider registers the guard, binds the slot to the guard or to `'web'`, and loads the routes below `BACK_OFFICE_PATH`:

```ts title="src/BackOfficeServiceProvider.ts"
import { can } from '@marmeon/auth';
import { PasskeyConfig } from '@marmeon/auth/passkeys';
import type { Container, ServiceProvider } from '@marmeon/core';
import { contentSecurityPolicy, defineRoutes, everyone, NONCE, Router } from '@marmeon/http';
import { Connections, SchemaRequirements } from '@marmeon/database';
import { BackOfficeConfig } from './BackOfficeConfig.ts';
import { OfficeBeginTwoFactorController } from './OfficeBeginTwoFactorController.ts';
import { ConfirmController } from './ConfirmController.ts';
import { ConfirmOfficeTwoFactorController } from './ConfirmOfficeTwoFactorController.ts';
import { DisableOfficeTwoFactorController } from './DisableOfficeTwoFactorController.ts';
import { EditorSignInLog } from './EditorSignInLog.ts';
import { EndSessionController } from './EndSessionController.ts';
import { EditorSlot, OfficeGuard } from './guard.ts';
import { OfficeLoginController } from './OfficeLoginController.ts';
import { OfficeLogoutController } from './OfficeLogoutController.ts';
import { OfficePasskeyChallengeController } from './OfficePasskeyChallengeController.ts';
import { OfficePasskeyChallengeOptionsController } from './OfficePasskeyChallengeOptionsController.ts';
import { OfficePasskeyConfirmController } from './OfficePasskeyConfirmController.ts';
import { OfficePasskeyConfirmOptionsController } from './OfficePasskeyConfirmOptionsController.ts';
import { OfficePasskeyRegistrationOptionsController } from './OfficePasskeyRegistrationOptionsController.ts';
import { OfficePasskeySignInController } from './OfficePasskeySignInController.ts';
import { OfficePasskeySignInOptionsController } from './OfficePasskeySignInOptionsController.ts';
import { OfficePasskeyStepUpController } from './OfficePasskeyStepUpController.ts';
import { OfficePasskeyStepUpOptionsController } from './OfficePasskeyStepUpOptionsController.ts';
import { OfficeTwoFactorChallengeController } from './OfficeTwoFactorChallengeController.ts';
import { OfficeTwoFactorVerifyController } from './OfficeTwoFactorVerifyController.ts';
import { OfficeAccess } from './OfficeAccess.ts';
import { OfficePolicy } from './OfficePolicy.ts';
import { OfficeRoles } from './OfficeRoles.ts';
import { officeRole } from './OfficeUser.ts';
import { OwnUsersOnly } from './OwnUsersOnly.ts';
import { OFFICE_USERS_COLUMNS, OfficeUserRepository } from './OfficeUserRepository.ts';
import { RedirectToOfficeSecurityController } from './RedirectToOfficeSecurityController.ts';
import { RegenerateOfficeRecoveryCodesController } from './RegenerateOfficeRecoveryCodesController.ts';
import { RegisterOfficePasskeyController } from './RegisterOfficePasskeyController.ts';
import { RemoveOfficePasskeyController } from './RemoveOfficePasskeyController.ts';
import { ShowConfirmController } from './ShowConfirmController.ts';
import { ShowOfficeLoginController } from './ShowOfficeLoginController.ts';
import { ShowOfficeTwoFactorChallengeController } from './ShowOfficeTwoFactorChallengeController.ts';
import { ShowOfficeTwoFactorVerifyController } from './ShowOfficeTwoFactorVerifyController.ts';
import { ShowOverviewController } from './ShowOverviewController.ts';
import { ShowSecureController } from './ShowSecureController.ts';
import { ShowOfficeSecurityController } from './ShowOfficeSecurityController.ts';
import { ShowSessionsController } from './ShowSessionsController.ts';

/**
 * Registers the back office: its routes below `BACK_OFFICE_PATH`, for the users `BACK_OFFICE_USERS` names. With `own` it defines the guard
 * `office` on its table, with its sign-in, second factors, passkeys, sign-in list and sudo mode; with `app` those routes answer 404, nobody signs in to the guard, and people go to the app's sign-in.
 */
export class BackOfficeServiceProvider implements ServiceProvider {
  // The guard's passkeys use the app's relying party, which an app that has not registered the passkey provider has not bound: the check happens at boot, so a later provider counts too.
  static config = [BackOfficeConfig, PasskeyConfig];
  static migrations = { from: new URL('../stubs/migrations', import.meta.url), module: 'back-office' };

  register(container: Container): void {
    const { users, path } = container.make(BackOfficeConfig);
    const own = users === 'own';
    // The guard is registered in both modes, and so are its tables and routes: the app's route list and its readiness never depend on the mode.
    // In the mode `app` the guard has no users and no route reaches it (the slot is bound to `'web'`).
    OfficeGuard.register(container);
    EditorSlot.bind(container, own ? OfficeGuard : 'web');
    container.singleton(EditorSignInLog);
    // The roles come from the table in the first mode and from the app's `OfficeAccess` in the second, never the app's for an editor's id.
    // Nothing bound means nobody has a role: the check asks at request time.
    // Whatever the app answers that is not one of the two roles is no role.
    container.singleton(OfficeRoles, (resolver) =>
      own ? resolver.make(OfficeUserRepository) : { roleOf: async (id) => (container.has(OfficeAccess) ? officeRole(await container.make(OfficeAccess).roleOf(id)) : undefined) },
    );

    // The back office's document gets this policy, not the app's: nothing but its own origin may load or be connected to.
    const policy = contentSecurityPolicy({ styleSrc: ["'self'", NONCE], imgSrc: ["'self'"], connectSrc: ["'self'"], frameAncestors: ["'none'"] });
    container.make(Router).load(
      { group: 'web', prefix: path },
      defineRoutes((Route) => {
        const area = Route.middleware(policy);
        // The overview is the same in both modes: the slot hands the request to the bound guard.
        area.middleware(EditorSlot.authenticate({ loginRoute: own ? 'office.login' : 'auth.login' })).authorize(can(OfficePolicy, 'open')).get('/', ShowOverviewController).name('office.index');

        // The routes below are the mode `own`'s: the sign-in, its second step, the sign-in list, the sudo mode and the security page are the guard's. They exist in both modes and answer 404 in the other.
        const own404 = area.middleware(OwnUsersOnly);
        const guests = own404.authorize(everyone).middleware(OfficeGuard.guest({ homeRoute: 'office.index' }));
        guests.get('/login', ShowOfficeLoginController).name('office.login');
        guests.middleware(OfficeGuard.throttle('login')).post('/login', OfficeLoginController).name('office.login.store');
        // The second step of the sign-in: a correct password waits here for the code (a guest still: nobody is signed in yet). One request per session at a time (`block()`).
        guests.get('/two-factor-challenge', ShowOfficeTwoFactorChallengeController).name('office.two-factor.challenge');
        guests.middleware(OfficeGuard.throttle('two-factor-challenge')).post('/two-factor-challenge', OfficeTwoFactorChallengeController).name('office.two-factor.challenge.store').block();
        guests.middleware(OfficeGuard.throttle('passkey-challenge-options')).post('/two-factor-challenge/passkey/options', OfficePasskeyChallengeOptionsController).name('office.passkeys.challenge.options');
        guests.middleware(OfficeGuard.throttle('passkey-challenge')).post('/two-factor-challenge/passkey', OfficePasskeyChallengeController).name('office.passkeys.challenge').block();
        // A passkey alone is a whole sign-in. The options open the session's one challenge and the answer spends it.
        guests.middleware(OfficeGuard.throttle('passkey-sign-in-options')).post('/passkeys/sign-in/options', OfficePasskeySignInOptionsController).name('office.passkeys.sign-in.options');
        guests.middleware(OfficeGuard.throttle('passkey-sign-in')).post('/passkeys/sign-in', OfficePasskeySignInController).name('office.passkeys.sign-in').block();
        const editors = own404.middleware(OfficeGuard.authenticate({ loginRoute: 'office.login' })).authorize(can(OfficePolicy, 'open'));
        // Signing out needs a signed-in editor and nothing else: an editor whose role is gone must still be able to end the sign-in.
        own404.middleware(OfficeGuard.authenticate({ loginRoute: 'office.login' })).authorize(everyone).post('/logout', OfficeLogoutController).name('office.logout');
        editors.get('/sessions', ShowSessionsController).name('office.sessions');
        editors.get('/confirm-password', ShowConfirmController).name('office.confirm');
        editors.post('/confirm-password', ConfirmController).name('office.confirm.store');
        // Confirming with a passkey: the options open a challenge per call, so they are limited per editor.
        editors.middleware(OfficeGuard.throttle('passkey-confirm-options')).post('/confirm-password/passkey/options', OfficePasskeyConfirmOptionsController).name('office.confirm.passkey.options');
        editors.post('/confirm-password/passkey', OfficePasskeyConfirmController).name('office.confirm.passkey').block();
        const sudo = editors.middleware(OfficeGuard.confirmedPassword({ confirmRoute: 'office.confirm' }));
        sudo.post('/sessions/:signIn/end', EndSessionController).name('office.sessions.end');
        sudo.get('/secure', ShowSecureController).name('office.secure');

        // Proving the second factor again in this session, where `confirmedSecondFactor()` sends a session that has not proven one lately. A wrong code ends nothing.
        editors.get('/two-factor-verify', ShowOfficeTwoFactorVerifyController).name('office.two-factor.verify');
        editors.post('/two-factor-verify', OfficeTwoFactorVerifyController).name('office.two-factor.verify.store').block();
        editors.middleware(OfficeGuard.throttle('passkey-step-up-options')).post('/two-factor-verify/passkey/options', OfficePasskeyStepUpOptionsController).name('office.passkeys.step-up.options');
        editors.post('/two-factor-verify/passkey', OfficePasskeyStepUpController).name('office.passkeys.step-up').block();
        // The factors: the sudo mode for all of it, and a factor proven within 15 minutes where the editor has one, because the guard's methods throw without it.
        const factors = sudo.middleware(OfficeGuard.confirmedSecondFactor({ verify: 'office.two-factor.verify' }));
        factors.get('/security', ShowOfficeSecurityController).name('office.security');
        factors.post('/security/two-factor/setup', OfficeBeginTwoFactorController).name('office.two-factor.begin');
        // Confirming needs a signed-in editor and the password in the form, not the sudo mode: the code of a setup that took a while to scan must not be lost.
        editors.post('/security/two-factor/confirm', ConfirmOfficeTwoFactorController).name('office.two-factor.confirm');
        factors.post('/security/two-factor/recovery-codes', RegenerateOfficeRecoveryCodesController).name('office.two-factor.codes');
        factors.post('/security/two-factor/disable', DisableOfficeTwoFactorController).name('office.two-factor.disable');
        // The recovery codes are a layer that answers these POSTs over the security page, shown once while it is open; a reload or Forward asks their addresses with a GET.
        editors.get('/security/two-factor/confirm', RedirectToOfficeSecurityController);
        editors.get('/security/two-factor/recovery-codes', RedirectToOfficeSecurityController);
        // Passkeys: adding one asks for the password again, and so does removing one.
        factors.post('/security/passkeys/options', OfficePasskeyRegistrationOptionsController).name('office.passkeys.options');
        factors.post('/security/passkeys', RegisterOfficePasskeyController).name('office.passkeys.store').block();
        factors.post('/security/passkeys/:passkey/remove', RemoveOfficePasskeyController).name('office.passkeys.destroy').block();
      }),
    );
  }

  boot(application: { container: Container }): void {
    const { container } = application;
    if (!container.has(Connections)) return;
    // Readiness waits for the editors' table in both modes, as it does for the guard's two tables: the app migrates all three.
    container.make(SchemaRequirements).require({ connection: 'default', table: 'office_users', columns: OFFICE_USERS_COLUMNS, secrets: ['password', 'session_key'] });
  }
}
```

- **The overview is the same in both modes.** `EditorSlot.authenticate()` hands the request to the bound guard. A guest of the back office goes to `office.login` in the mode `own` and to the app's `auth.login` in the mode `app`. A customer of the app is a guest of the guard `office`, even when a customer and an editor have the same id.
- **The routes of the mode `own` exist in both modes.** `OwnUsersOnly` stands before the guard's middleware and answers 404 in the mode `app`, for a GET and a POST alike, before anything looks at a session. The sign-in and its second step, the passkey routes, the sign-out, the list of the editor's sign-ins, the sudo mode and the security page are the guard's.
- **The provider carries the passkey configuration.** `static config = [BackOfficeConfig, PasskeyConfig]` binds the relying party for an app that has not registered the passkey provider. The check runs at boot, so a provider that comes later counts too ([for a guard of a package](passkeys.md#for-a-guard-of-a-package)).
- **Two limits count sign-ins, and the guard has its own of each.** The route limit `OfficeGuard.throttle('login')` lets one client post 30 sign-ins a minute, whatever the addresses. Inside the sign-in, `attempt()` allows five a minute for one address from one client (`AUTH_LOGIN_ATTEMPTS_PER_MINUTE`) and 100 password sign-ins a day for one account, counted from the last successful one (`AUTH_ACCOUNT_SIGN_INS_PER_DAY`). All of them are counted under the guard's name, apart from the app's.
- **The device cookie is the way back.** A sign-in with the password hands the browser the guard's device cookie, which keeps the editor signing in after strangers have used up the account's daily count. Without it, anyone who knows an editor's address could lock them out, and this package has no password reset yet. The login controller sets it as the app's does.
- **The sudo window is the guard's.** `OfficeGuard.confirmedPassword()` asks the editor for the back office password, although the customer's window of the app is open, and the editor's confirmation opens nothing in the app. The page that ends another sign-in and the page `/office/secure` need it.
- **The page a guest wanted is the back office's.** The session keeps one such page for all guards, not one for each. The sign-in and the confirmation follow it only when it lies below the back office's path, and leave a page of the app in place. The other direction is the app's: its sign-in follows whatever page was stored last, so a visit to a page of the back office after a customer's wish replaces that wish.
- **The group has a policy of its own.** The back office's document gets its own content security policy, not the app's.

The web app's own middleware shares the signed-in user and the notification bell with every page of its `web` group. In the mode `own` it leaves out the pages of the back office's own guard, so a customer signed in in the same browser shows no name there and the page follows no channel of the customer's.

## Two factors and passkeys

An editor sets up an authenticator app on the security page, `/office/security`, and adds passkeys there. The package writes its own controllers and pages for them, and each controller calls one method of the guard's services, `OfficeAuth`, `OfficeTwoFactor` and `OfficePasskeys`. The starter kit's controllers do the same for the app's users, so each one in the table is the template for the package's: copy it, take the guard's service in `static inject` in place of the app's, and name the routes `office.…`.

| Page or request | Controller of the package | Method of the guard's service | Template in the starter kit (`modules/auth/…`) |
|---|---|---|---|
| The second step after the password | `ShowOfficeTwoFactorChallengeController` | `OfficeAuth.pendingSecondFactor()` | `controllers/ShowTwoFactorChallengeController.ts` |
| A code or a recovery code | `OfficeTwoFactorChallengeController` | `OfficeTwoFactor.challenge({ code })`, `challenge({ recoveryCode })` | `controllers/TwoFactorChallengeController.ts` |
| A passkey after the password | `OfficePasskeyChallengeOptionsController`, `OfficePasskeyChallengeController` | `OfficePasskeys.challengeOptions()`, `OfficeTwoFactor.challenge({ passkey })` | `controllers/PasskeyChallengeOptionsController.ts`, `controllers/PasskeyChallengeController.ts` |
| Signing in with a passkey alone | `OfficePasskeySignInOptionsController`, `OfficePasskeySignInController` | `OfficePasskeys.signInOptions()`, `signIn()` | `controllers/PasskeySignInOptionsController.ts`, `controllers/PasskeySignInController.ts` |
| The security page | `ShowOfficeSecurityController` | `OfficeTwoFactor.status()`, `setup()`, `OfficePasskeys.list()` | `controllers/ShowTwoFactorController.ts`, `controllers/ShowPasskeysController.ts` |
| Starting the authenticator app | `OfficeBeginTwoFactorController` | `OfficeTwoFactor.begin()` | `controllers/BeginTwoFactorController.ts` |
| Turning it on with the first code | `ConfirmOfficeTwoFactorController` | `OfficeTwoFactor.confirm(code, password)` | `controllers/ConfirmTwoFactorController.ts` |
| Turning it off | `DisableOfficeTwoFactorController` | `OfficeTwoFactor.disable(password)` | `controllers/DisableTwoFactorController.ts` |
| New recovery codes | `RegenerateOfficeRecoveryCodesController` | `OfficeTwoFactor.regenerateRecoveryCodes(password)` | `controllers/RegenerateRecoveryCodesController.ts` |
| Adding a passkey | `OfficePasskeyRegistrationOptionsController`, `RegisterOfficePasskeyController` | `OfficePasskeys.registrationOptions()`, `register(response, name, password)` | `controllers/PasskeyRegistrationOptionsController.ts`, `controllers/RegisterPasskeyController.ts` |
| Removing a passkey | `RemoveOfficePasskeyController` | `OfficePasskeys.remove(id, password)` | `controllers/RemovePasskeyController.ts` |
| The sudo mode with a passkey | `OfficePasskeyConfirmOptionsController`, `OfficePasskeyConfirmController` | `OfficePasskeys.confirmOptions()`, `confirm()` | `controllers/PasskeyConfirmOptionsController.ts`, `controllers/PasskeyConfirmController.ts` |
| Proving a factor again | `ShowOfficeTwoFactorVerifyController`, `OfficeTwoFactorVerifyController` | `OfficeTwoFactor.status()`, `stepUp({ code })`, `stepUp({ recoveryCode })` | `controllers/ShowTwoFactorVerifyController.ts`, `controllers/TwoFactorVerifyController.ts` |
| The recovery codes, reloaded or Forward | `RedirectToOfficeSecurityController` | none: it redirects to the security page | `controllers/RedirectToTwoFactorController.ts` |
| Proving a passkey again | `OfficePasskeyStepUpOptionsController`, `OfficePasskeyStepUpController` | `OfficePasskeys.stepUpOptions()`, `OfficeTwoFactor.stepUp({ passkey })` | `controllers/PasskeyStepUpOptionsController.ts`, `controllers/PasskeyStepUpController.ts` |

Three pages of the package replace the starter kit's views: `office::Security` joins its two-factor and passkeys pages, `office::Challenge` is its sign-in challenge and its verify page in one (the prop `step` says which), and `office::RecoveryCodes` is its recovery codes layer.

The starter kit's pages for renaming a passkey and releasing a suspended one are not in the package: a passkey whose counter went backwards is suspended, and the editor removes it and adds a new one.

The routes keep the order the starter kit uses:

- **The second step is a guest page.** A correct password does not sign anybody in while the editor has a factor: `attempt()` answers `two-factor-required` and `OfficeLoginController` sends the browser to `office.two-factor.challenge`. The challenge routes sit behind `OfficeGuard.guest()` and have their own limits (`OfficeGuard.throttle('two-factor-challenge')` and the passkey ones), and a request that checks an answer is `block()`ed, so two codes of one session are never counted at once. After five wrong codes the wait ends and the editor types the password again.
- **The security page is behind the sudo mode and a proven factor.** `OfficeGuard.confirmedPassword()` comes first, then `OfficeGuard.confirmedSecondFactor({ verify: 'office.two-factor.verify' })`: an editor who has a factor and proved none in the last 15 minutes is sent to the page that asks again, because the guard's methods that change a factor throw without that proof. Turning the authenticator on is the one request outside the sudo mode, since it carries the password in its form, and a setup that took a while to scan must not lose its code.
- **Every change asks for the password again.** The controllers pass the password typed now to `confirm()`, `disable()`, `regenerateRecoveryCodes()`, `register()` and `remove()`, which check it under the guard's limits.
- **A passkey is the editor's own and nobody else's.** The passkey routes answer the guard's `office_passkeys`: the passkey of a customer with the same id signs in at the app and not at the back office, and the editor's does the other way round, with the same answer as for an unknown passkey.
- **The sudo mode takes a passkey in place of the password.** `OfficePasskeyConfirmController` opens the window of `OfficeGuard.confirmedPassword()`, the same one as the password's.
- **A sign-in follows the page the editor wanted only below the back office.** The sign-in, the second step and the passkey sign-in go on to `intended()` only when `intendedBelow()` says the stored page is one of the back office's; otherwise they go to the overview.

The recovery codes are a layer over the security page that answers the POST (`office::RecoveryCodes`, the key `office.two-factor.codes`), as in the starter kit. They never sit in the session or in a history entry, the database keeps their hashes, closing the layer drops them from the tab's memory (Done is a link to the security page, so a browser without JavaScript leaves the layer too), and Back or Forward asks their address with a GET that redirects to the security page. The codes of a first passkey come back as JSON and live in the page's state only.

The package mails the editor about what happens to their sign-ins and factors, through the guard's events. `OfficeNotices` reads the address from `office_users` by the id the guard's event carries and queues an `OfficeSecurityMail` to it. The app lists the four queued listeners in its module next to `RecordEditorSignIn`:

| The guard's event | Listener | The mail says |
|---|---|---|
| `OfficeGuard.events.SignedIn` | `NotifyEditorOfSignIn` | A new sign-in, with its time. |
| `OfficeGuard.events.TwoFactorEnabled` | `NotifyEditorOfTwoFactorEnabled` | A second factor was turned on. |
| `OfficeGuard.events.TwoFactorDisabled` | `NotifyEditorOfTwoFactorDisabled` | The authenticator app was removed and the passkeys still protect the account, or the second factor is off when no passkey of the guard is left. An operator's removal and a reset have their own texts. |
| `OfficeGuard.events.PasskeyRegistered` | `NotifyEditorOfPasskeyAdded` | A passkey was added. |

The mail listeners need a bound `Mailer` and a running mail queue (`marmeon queue:work`, which `marmeon dev` starts), and `@marmeon/mail` is a peer dependency of the package. Each listener mails only a payload of the guard `office`: a payload that names another guard mails nobody. The passkeys use the app's relying party, so `APP_URL`, `AUTH_PASSKEY_RP_ID` and `AUTH_PASSKEY_ORIGINS` apply to the back office as they do to the app ([for a guard of a package](passkeys.md#for-a-guard-of-a-package)).

A listener of the app's own `SignedIn` never hears the guard's event, so the customer with the editor's id gets no mail and no notification about it ([events of a guard](authentication.md#events-of-a-guard)). In the mode `app` the guard has no users and raises nothing, and the app's own listeners tell the customers.

Ending a sign-in of the back office ends the browser's session: an ended sign-in row, `AccountSessions.end()`, a new password, a passkey that looks copied and `sessionMaxHours` all do. The customer of the app who is signed in in the same browser is signed out with it, and the same customer in another browser is not ([signing out](authentication.md#signing-out)).

## The roles

The policy names the slot and asks for the editor's role through a token the package binds by mode, `OfficeRoles`. In the mode `own` the answer is the column `role` of the editor's row. In the mode `app` it is the app's `OfficeAccess`, which the app binds. The package never asks `OfficeAccess` for an editor of its own table: the ids of the two tables are other people.

```ts title="src/OfficeAccess.ts"
import { token } from '@marmeon/core';
import type { OfficeRole } from './OfficeUser.ts';

/**
 * Which role the app gives one of its users in the back office, for the mode that serves the app's users (`BACK_OFFICE_USERS=app`). The app
 * binds it; the package never decides for it, so an app that binds nothing admits nobody. The own mode never asks it: its editors are
 * another set of accounts whose ids mean other people.
 */
export interface OfficeAccess {
  roleOf(userId: number): OfficeRole | undefined | Promise<OfficeRole | undefined>;
}
export const OfficeAccess = token<OfficeAccess>('OfficeAccess');
```

```ts title="src/OfficePolicy.ts"
import { EditorSlot } from './guard.ts';
import { OfficeRoles } from './OfficeRoles.ts';
import type { EditorUser } from './OfficeUser.ts';

/** What an editor may do. It names the slot, so it judges the editors of the mode the back office runs in, never the other mode's accounts. */
export class OfficePolicy {
  static readonly guard = EditorSlot;
  static readonly inject = [OfficeRoles] as const;

  readonly #roles: OfficeRoles;

  constructor(roles: OfficeRoles) {
    this.#roles = roles;
  }

  /** Enter the back office: a role of the two the package knows, and nothing else. */
  async open(user: EditorUser): Promise<boolean> {
    const role = await this.#roles.roleOf(user.id);
    return role === 'editor' || role === 'viewer';
  }

  /** Publish: editors, not viewers. */
  async publish(user: EditorUser): Promise<boolean> {
    return (await this.#roles.roleOf(user.id)) === 'editor';
  }
}
```

Only `editor` and `viewer` are roles. Anything else, such as a row whose `role` is `suspended` or empty, or an answer of the app's `OfficeAccess` that is `null` or another text, is no role and opens nothing: the policy, the binding and the listener each allow the two names and refuse the rest. An app that binds nothing admits nobody in the mode `app`: the check asks at request time, and a missing binding is no role. The overview takes its capability prop from the same policy (`gate.allows(OfficePolicy, 'publish')`), so the page offers publishing to editors only.

In the mode `own` the back office is a guard of its own, so a policy of the app on one of its routes answers no, never yes: the prop is `false` and the action is a 403, and in development the first such question writes a warning with error [A9](errors.md#server-error-codes) ([policies of a guard](authorization.md#policies-of-a-guard)). In the mode `app` the back office's routes belong to the app's guard, and a policy of the app is judged as on any page of the app.

## What the app does for the back office

Keep the app's shared props off the package's pages. The web app's `ShareAppProps` asks `auth.ownsRoute()` first and returns before it shares the signed-in user, the bell and the live channel on a route that is not the app's, so a customer signed in in the same browser shows no name on a page of the back office, wherever the package mounts it. In the mode `app` the overview belongs to the app's guard, and it carries the customer's shared props like any page of the app. See [whose route a request is on](authentication.md#whose-route-a-request-is-on).

The app takes the migrations over, and in the mode `app` it binds `OfficeAccess`. The web app says that its administrators, the ones `DASHBOARD_ADMINS` lists, are editors, as long as their address is confirmed; every other customer has no role in the back office:

```ts title="modules/back-office/OfficeAccessServiceProvider.ts"
import type { VerifiableUser } from '@marmeon/auth';
import type { Container, ServiceProvider } from '@marmeon/core';
import { OfficeAccess } from '@acme/back-office';
import { UserRepository } from '#modules/auth';
import { DashboardConfig } from '#modules/dashboard';

/**
 * With `BACK_OFFICE_USERS=app` the back office serves the app's users, and the app says who is an editor: the administrators the dashboard
 * knows (`DASHBOARD_ADMINS`), with a confirmed address. Every other customer has no role there. In the default mode (`own`) the back office
 * never asks this: its editors are accounts of `office_users`, and an id of that table is not an id of `users`.
 */
export class OfficeAccessServiceProvider implements ServiceProvider {
  register(container: Container): void {
    container.singleton(OfficeAccess, (resolver) => {
      const { admins } = resolver.make(DashboardConfig);
      return {
        roleOf: async (id) => {
          const user = await container.make(UserRepository).find(id);
          return user !== undefined && (user as VerifiableUser).email_verified_at != null && admins.includes(user.email.toLowerCase()) ? 'editor' : undefined;
        },
      };
    });
  }
}
```

The package records the editors' sign-ins with a listener the app lists, and the mails to the editors are listeners too (five in all, the mails for the mode `own`). Packages do not register listeners, so the app lists them in the module that owns the package's tables, the recorder for the slot's event, which follows the binding:

```ts title="modules/back-office/index.ts"
import {
  EditorSlot,
  NotifyEditorOfPasskeyAdded,
  NotifyEditorOfSignIn,
  NotifyEditorOfTwoFactorDisabled,
  NotifyEditorOfTwoFactorEnabled,
  OfficeGuard,
  RecordEditorSignIn,
} from '@acme/back-office';
import { defineModule, listen } from '@marmeon/core';
import { OfficeAccessServiceProvider } from './OfficeAccessServiceProvider.ts';
import { OfficeUsersSeeder } from './OfficeUsersSeeder.ts';

// The tables of @acme/back-office: `marmeon publish @acme/back-office` writes their migrations here.
// They are the app's now — change them like any other migration.
export default defineModule({
  name: 'back-office',
  // `BACK_OFFICE_USERS=app` only: who is an editor among the app's users.
  providers: [OfficeAccessServiceProvider],
  // The package never registers listeners: the app lists the one that records editor sign-ins, whichever users the back office runs on, and the four
  // that mail the editors (the mode `own`).
  listeners: [
    listen(EditorSlot.events.SignedIn, RecordEditorSignIn),
    // The mails to the editors go through the guard's own events, never the app's: a listener of the app would mail the customer with the same id. They are
    // for the mode `own`; in the mode `app` the guard has no users and raises nothing.
    listen(OfficeGuard.events.SignedIn, NotifyEditorOfSignIn),
    listen(OfficeGuard.events.TwoFactorEnabled, NotifyEditorOfTwoFactorEnabled),
    listen(OfficeGuard.events.TwoFactorDisabled, NotifyEditorOfTwoFactorDisabled),
    listen(OfficeGuard.events.PasskeyRegistered, NotifyEditorOfPasskeyAdded),
  ],
  migrations: new URL('./migrations/', import.meta.url),
  seeders: [OfficeUsersSeeder],
});
```

`RecordEditorSignIn` writes `(guard, userId, at)` to the package's `EditorSignInLog`: `('office', 1)` for the editor with the id 1 in the mode `own`, `('web', 1)` for the customer with the id 1 in the mode `app`. It keeps the guard with the id, because the same id in the two modes is two people, and it records only the sign-ins the back office gives a role: the slot of the mode `app` hears every sign-in of the app, customers included ([events of a guard slot](authentication.md#events-of-a-guard-slot)). A sign-in of a customer in the mode `own` never reaches it.

```ts title="src/RecordEditorSignIn.ts"
import { EditorSignInLog } from './EditorSignInLog.ts';
import { EditorSlot } from './guard.ts';
import { OfficeRoles } from './OfficeRoles.ts';

/**
 * Records the editor sign-ins: one entry of the mode and the id for each. The app lists it for `EditorSlot.events.SignedIn`
 * (`docs/package-users.md#what-the-app-does-for-the-back-office`). A slot bound to the app's users hears every sign-in of the app, customers
 * included, so it records only the ones the back office gives a role.
 */
export class RecordEditorSignIn {
  static readonly inject = [EditorSignInLog, OfficeRoles] as const;

  readonly #log: EditorSignInLog;
  readonly #roles: OfficeRoles;

  constructor(log: EditorSignInLog, roles: OfficeRoles) {
    this.#log = log;
    this.#roles = roles;
  }

  async handle(event: InstanceType<typeof EditorSlot.events.SignedIn>): Promise<void> {
    const role = await this.#roles.roleOf(event.user.id);
    if (role !== 'editor' && role !== 'viewer') return;
    this.#log.record({ guard: event.guard, userId: event.user.id, at: event.at });
  }
}
```

## What the web app proves

The web app runs the claims above against the real package (`apps/web-app/modules/back-office`). In the mode `own`: a guest and a customer are sent to the back office's sign-in, an editor signs in, the list of sign-ins and the sudo window work and are the guard's, the sixth sign-in of a minute is `throttled` while the app's counter stays at zero, a locked account lets the owner's browser in through its device cookie, the capability prop follows the role and an unknown role opens nothing, and a policy of the app on a route of the back office says no, and a route of the office guard shares nothing of the customer's, whatever its path. An editor sets up an authenticator app and is asked for its code at the next sign-in, a wrong code is refused and a recovery code works once. An editor signs in with a passkey alone, the app's passkey sign-in refuses it and the back office refuses a customer's, and a passkey opens the sudo window. The mail of a new sign-in goes to the editor's address and never to the customer with the same id, and ending an editor's sign-in signs the customer out in the same browser. In the mode `app`: the overview carries the customer's shared props, the customers are judged by `OfficeAccess` with the table `office_users` never read, an answer that is no role admits nobody, the routes of the mode `own`, the second factors and passkeys among them, answer 404, and the route list is the same as in the mode `own`. `back-office-build.test.ts` builds a copy of the app and checks that no document of the app loads the back office's pages or texts.

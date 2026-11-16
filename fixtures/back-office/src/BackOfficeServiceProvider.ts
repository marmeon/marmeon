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

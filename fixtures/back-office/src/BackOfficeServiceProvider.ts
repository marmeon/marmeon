import { can } from '@marmeon/auth';
import type { Container, ServiceProvider } from '@marmeon/core';
import { contentSecurityPolicy, defineRoutes, everyone, NONCE, Router } from '@marmeon/http';
import { Connections, SchemaRequirements } from '@marmeon/database';
import { BackOfficeConfig } from './BackOfficeConfig.ts';
import { ConfirmController } from './ConfirmController.ts';
import { EditorSignInLog } from './EditorSignInLog.ts';
import { EndSessionController } from './EndSessionController.ts';
import { EditorSlot, OfficeGuard } from './guard.ts';
import { OfficeLoginController } from './OfficeLoginController.ts';
import { OfficeLogoutController } from './OfficeLogoutController.ts';
import { OfficeAccess } from './OfficeAccess.ts';
import { OfficePolicy } from './OfficePolicy.ts';
import { OfficeRoles } from './OfficeRoles.ts';
import { officeRole } from './OfficeUser.ts';
import { OwnUsersOnly } from './OwnUsersOnly.ts';
import { OFFICE_USERS_COLUMNS, OfficeUserRepository } from './OfficeUserRepository.ts';
import { ShowConfirmController } from './ShowConfirmController.ts';
import { ShowOfficeLoginController } from './ShowOfficeLoginController.ts';
import { ShowOverviewController } from './ShowOverviewController.ts';
import { ShowSecureController } from './ShowSecureController.ts';
import { ShowSessionsController } from './ShowSessionsController.ts';

/**
 * Registers the back office: its routes below `BACK_OFFICE_PATH`, for the users `BACK_OFFICE_USERS` names. With `own` it defines the guard
 * `office` on its table, with its sign-in, sign-in list and sudo mode; with `app` those routes answer 404, nobody signs in to the guard, and people go to the app's sign-in.
 */
export class BackOfficeServiceProvider implements ServiceProvider {
  static config = [BackOfficeConfig];
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

        // The routes below are the mode `own`'s: the sign-in, the sign-in list and the sudo mode are the guard's. They exist in both modes and answer 404 in the other.
        const own404 = area.middleware(OwnUsersOnly);
        const guests = own404.authorize(everyone).middleware(OfficeGuard.guest({ homeRoute: 'office.index' }));
        guests.get('/login', ShowOfficeLoginController).name('office.login');
        guests.middleware(OfficeGuard.throttle('login')).post('/login', OfficeLoginController).name('office.login.store');
        const editors = own404.middleware(OfficeGuard.authenticate({ loginRoute: 'office.login' })).authorize(can(OfficePolicy, 'open'));
        // Signing out needs a signed-in editor and nothing else: an editor whose role is gone must still be able to end the sign-in.
        own404.middleware(OfficeGuard.authenticate({ loginRoute: 'office.login' })).authorize(everyone).post('/logout', OfficeLogoutController).name('office.logout');
        editors.get('/sessions', ShowSessionsController).name('office.sessions');
        editors.get('/confirm-password', ShowConfirmController).name('office.confirm');
        editors.post('/confirm-password', ConfirmController).name('office.confirm.store');
        const sudo = editors.middleware(OfficeGuard.confirmedPassword({ confirmRoute: 'office.confirm' }));
        sudo.post('/sessions/:signIn/end', EndSessionController).name('office.sessions.end');
        sudo.get('/secure', ShowSecureController).name('office.secure');
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

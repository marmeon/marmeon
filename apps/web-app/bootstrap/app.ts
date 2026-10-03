import { join } from 'node:path';
import { defineApplication } from '@bespokecore/core';
import auth from '#modules/auth';
import dashboard from '#modules/dashboard';
import lab from '#modules/lab';
import locale from '#modules/locale';
import notifications from '#modules/notifications';
import system from '#modules/system';
import userProfile from '#modules/user-profile';
import { AppConfig } from '../config/app.ts';
import { SystemDatabase } from '../config/database.ts';
import { AppStorage } from '../config/storage.ts';
import { SecurityHeaders } from '../middleware/SecurityHeaders.ts';
import { ShareAppProps } from '../middleware/ShareAppProps.ts';

/**
 * The composition root. It only describes the app: `bespoke` boots it, and tests
 * boot a fresh instance per test. Installed packages (including the framework's
 * own, like @bespokecore/http) register themselves through discovery.
 */
export default defineApplication({
  root: join(import.meta.dirname, '..'),
  config: [AppConfig, SystemDatabase, AppStorage],
  modules: [auth, userProfile, dashboard, notifications, locale, lab, system],
  // Added after the framework's own middleware. Module routes run in the `web` group
  // (cookies, session, CSRF), `apiRoutes` in the stateless `api` group under /api.
  middleware: {
    global: [SecurityHeaders],
    web: [ShareAppProps],
  },
  // The browser learns only the `web` routes its code names (virtual:bespoke/routes). API routes stay on the server
  // unless listed in `clientRoutes: { include }`; `.internal()` routes (the signed e-mail verification link) always do.
});

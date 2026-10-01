import { join } from 'node:path';
import { defineApplication } from '@bespokecore/core';
import auth from '#modules/auth';
import lab from '#modules/lab';
import userProfile from '#modules/user-profile';
import { AppConfig } from '../config/app.ts';
import { SecurityHeaders } from '../middleware/SecurityHeaders.ts';
import { ShareAppProps } from '../middleware/ShareAppProps.ts';

/**
 * The composition root. It only describes the app: `bespoke` boots it, and tests
 * boot a fresh instance per test. Installed packages (including the framework's
 * own, like @bespokecore/http) register themselves through discovery.
 */
export default defineApplication({
  root: join(import.meta.dirname, '..'),
  config: [AppConfig],
  modules: [auth, userProfile, lab],
  // Added after the framework's own middleware. Module routes run in the `web` group
  // (cookies, session, CSRF), `apiRoutes` in the stateless `api` group under /api.
  middleware: {
    global: [SecurityHeaders],
    web: [ShareAppProps],
  },
  // The browser gets the named `web` routes (bootstrap/routes.ts) — not the e-mail verification link, which only
  // the server signs and sends by mail. API routes stay on the server unless listed in `include`.
  clientRoutes: { except: ['auth.verification.verify'] },
});

import { join } from 'node:path';
import { defineApplication } from '@marmeon/core';
import { contentSecurityPolicy, NONCE, securityHeaders } from '@marmeon/http';
import auth from '#modules/auth';
import dashboard from '#modules/dashboard';
import lab from '#modules/lab';
import locale from '#modules/locale';
import members from '#modules/members';
import notifications from '#modules/notifications';
import system from '#modules/system';
import userProfile from '#modules/user-profile';
import { AppConfig } from '../config/app.ts';
import { SystemDatabase } from '../config/database.ts';
import { AppStorage } from '../config/storage.ts';
import { ShareAppProps } from '../middleware/ShareAppProps.ts';
import bookmarks from '#modules/bookmarks';

/**
 * The composition root. It only describes the app: `marmeon` boots it, and tests
 * boot a fresh instance per test. Installed packages (including the framework's
 * own, like @marmeon/http) register themselves through discovery.
 */
export default defineApplication({
  root: join(import.meta.dirname, '..'),
  config: [AppConfig, SystemDatabase, AppStorage],
  modules: [auth, userProfile, dashboard, members, notifications, locale, lab, system, bookmarks],
  // Added after the framework's own middleware. Module routes run in the `web` group
  // (cookies, session, CSRF), `apiRoutes` in the stateless `api` group under /api.
  middleware: {
    // A strict Content-Security-Policy on every document: scripts only with the response's nonce ('strict-dynamic'),
    // no plugins, no foreign <base>; framed by nobody. Styles: stylesheets of the app's origin and <style> elements with
    // the nonce (Vite's in development, the devtools' bar) — no 'unsafe-inline': not one `style` attribute in the markup.
    global: [securityHeaders(), contentSecurityPolicy({ styleSrc: ["'self'", NONCE], frameAncestors: ["'none'"] })],
    web: [ShareAppProps],
  },
  // The browser learns only the `web` routes its code names (virtual:marmeon/routes). API routes stay on the server
  // unless listed in `clientRoutes: { include }`; `.internal()` routes (the signed e-mail verification link) always do.
});

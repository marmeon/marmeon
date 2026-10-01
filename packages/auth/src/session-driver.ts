import { Logger, type Container } from '@bespokecore/core';
import { SessionConfig } from '@bespokecore/session';

/** What the boot logs when an app with sign-in keeps its sessions in the cookie (E46). */
export const COOKIE_SESSION_WARNING =
  'SESSION_DRIVER=cookie with sign-in (@bespokecore/auth): the whole session lives in the cookie, so a sign-out can be undone by a ' +
  'request that was still in flight — its response brings back the signed-in cookie. Use SESSION_DRIVER=file (or, later, database/redis) ' +
  'for apps with login.';

/**
 * Warns once, at boot, when auth meets the cookie session driver. The server-side drivers refuse to write back a session
 * a sign-out destroyed meanwhile (`Session.save()`); the cookie driver cannot know — its data travels with each response.
 */
export function warnAboutCookieSessions(container: Container): void {
  if (!container.has(SessionConfig) || container.make(SessionConfig).driver !== 'cookie') return;
  container.make(Logger).warn(COOKIE_SESSION_WARNING, { driver: 'cookie' });
}

import { token } from '@bespokecore/core';

/**
 * What a page needs to know of the request's session (E64) — bound per request by `@bespokecore/session`; without a session
 * both are undefined. The http package knows no session itself.
 */
export interface PageSession {
  /** The CSRF token, for forms that work without JavaScript (`<Form>` renders it as `_token`, `PageObject.csrf`). */
  csrfToken(): string | undefined;
  /**
   * Who the page is for — opaque, never the session id itself (a hash of it), and different after every sign-in and sign-out
   * (the session id is regenerated). Once props (E64) the browser holds count only under the same scope.
   */
  scope(): string | undefined;
}
export const PageSession = token<PageSession>('PageSession');

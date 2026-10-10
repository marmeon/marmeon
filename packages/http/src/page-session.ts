import { token } from '@marmeon/core';

/**
 * What a page needs to know of the request's session — bound per request by `@marmeon/session`; without a session
 * both are undefined. The http package knows no session itself.
 */
export interface PageSession {
  /**
   * The CSRF token, for forms that work without JavaScript (`<Form>` renders it as `_token`, `PageObject.csrf`) — of a session
   * that is kept. A guest without a session gets none: their forms pass by the browser's word (Fetch Metadata, Origin).
   */
  csrfToken(): string | undefined;
  /**
   * Who the page is for — opaque, never the session id itself (a hash of it), and new after every sign-in and sign-out. Once
   * props the browser holds count only under the same scope. Undefined without a kept session, unless `keep` keeps it (for a
   * live subscription a page signs).
   */
  scope(options?: { readonly keep?: boolean }): string | undefined;
  /**
   * The session's generation for the tab-sync epoch: the scope of a signed-in user's session with the user's id — new with
   * every sign-in, sign-out and regenerated id. Undefined for a guest, so a guest's session writes never reload other tabs.
   * Never the session id itself.
   */
  generation(): string | undefined;
}
export const PageSession = token<PageSession>('PageSession');

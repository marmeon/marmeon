import { token } from '@marmeon/core';

/**
 * What a page needs to know of the request's session — bound per request by `@marmeon/session`; without a session
 * both are undefined. The http package knows no session itself.
 */
export interface PageSession {
  /**
   * Whether the session middleware started a session on this request — also a guest's new one. On a page that did not start one,
   * an island whose route starts the session loads in the browser, since a shared cache may keep the page. It does not decide
   * whether islands get the request's cookies.
   */
  started(): boolean;
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
   * every sign-in, sign-out and regenerated id, unchanged by other writes (a flash message reloads no other tab). Undefined
   * for a guest: nothing of a guest's is protected, so a guest's session never reloads other tabs. Never the session id itself.
   */
  generation(): string | undefined;
  /**
   * When the session began to be read for this request (ms, `performance.timeOrigin + performance.now()`), before the store
   * answered: an end of the session after it may not be known to what was read. Undefined without a session.
   */
  readAt(): number | undefined;
}
export const PageSession = token<PageSession>('PageSession');

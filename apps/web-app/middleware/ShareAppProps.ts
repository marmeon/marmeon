import { BackOfficeConfig } from '@fixtures/back-office';
import { Auth } from '@marmeon/auth';
import { once, SharedData, type HttpContext, type Next } from '@marmeon/http';
import { Locales } from '@marmeon/i18n';
import { Inbox } from '@marmeon/notifications';
import { notificationsChannel } from '@marmeon/live';

declare module '@marmeon/http/page' {
  /**
   * Optional on purpose: shared by the `web` group's middleware — a path without a route (a 404) passes no group, so its error
   * page has none of them, and the layout around it renders without them (no session is started for a bot's scan either).
   */
  interface SharedProps {
    /**
     * The signed-in user, on every page of the `web` group — or null. Shared props reach every page, in its HTML and its
     * JSON: share only what pages show, so no id.
     */
    auth?: { user: { name: string; verified: boolean } | null };
    /** The languages of the switcher (the page's own is `usePage().locale`). */
    locales?: readonly string[];
    /** The bell in the header: how many of the signed-in user's notifications are unread — null for guests. */
    bell?: { unread: number } | null;
  }

  /**
   * The app's flash messages: `redirect().flash('toast', { kind: 'success', message })` in a controller, a toast in the
   * layout (`useFlash('toast', …)`) — exactly once per message. No shared prop: the protocol carries them.
   */
  interface FlashData {
    toast: { kind: 'success' | 'error' | 'info'; message: string };
    /** The member import's preview: the id of the kept upload the confirmation takes over, and how many rows it read. */
    memberImport: { id: string; rows: number };
  }
}

/**
 * Shares what every page of the app shows.
 * Lazy: evaluated only when a page renders — redirects and JSON never look up the user.
 */
export class ShareAppProps {
  readonly #shared: SharedData;
  readonly #auth: Auth;
  readonly #locales: Locales;
  readonly #inbox: Inbox;
  readonly #backOffice: BackOfficeConfig;

  constructor(shared: SharedData, auth: Auth, locales: Locales, inbox: Inbox, backOffice: BackOfficeConfig) {
    this.#shared = shared;
    this.#auth = auth;
    this.#locales = locales;
    this.#inbox = inbox;
    this.#backOffice = backOffice;
  }

  handle(ctx: HttpContext, next: Next<{}>) {
    // The back office package's pages are for another set of people: they share nothing of the app's user, so a customer signed in in the same
    // browser shows no name there and the page follows no notification channel of the customer's. The package mounts every route below its
    // path, which is what is asked here; a way to ask a route's guard would replace this.
    // The matched route's pattern, not the request's path: the router matches the decoded path, so `/%6Fffice` is the back office's page too.
    const { path } = this.#backOffice;
    const pattern = ctx.route?.path;
    if (pattern !== undefined && (pattern === path || pattern.startsWith(`${path}/`))) return next();
    this.#shared
      .share('auth', async () => {
        // The same lookup authenticate() already made on this request (Auth is per request).
        const user = await this.#auth.user();
        return { user: user ? { name: user.name, verified: user.email_verified_at !== null } : null };
      })
      // One count per page, only when a page renders (and only this with `only: ['bell']`) — the list is its own page.
      .share('bell', async () => {
        const user = await this.#auth.user();
        return user ? { unread: await this.#inbox.count({ type: 'user', id: user.id }) } : null;
      })
      // The same list on every page: sent with the first page, then kept by the browser — the server skips it while the
      // tab holds it. A language switch or signing in or out is a full load: it comes again then.
      .share('locales', once(() => this.#locales.supported))
      // Live: the bell reloads when a notification arrives (the `live` channel of NewSignInNotification) or one is
      // read in another tab — no polling. A guest follows nothing.
      .live(
        async () => {
          const user = await this.#auth.user();
          return user ? notificationsChannel({ type: 'user', id: user.id }) : undefined;
        },
        { only: ['bell'] },
      );
    return next();
  }
}

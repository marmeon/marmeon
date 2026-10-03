import { Auth } from '@bespokecore/auth';
import { once, SharedData, type HttpContext, type Next } from '@bespokecore/http';
import { Locales } from '@bespokecore/i18n';
import { Inbox } from '@bespokecore/notifications';

declare module '@bespokecore/http/page' {
  interface SharedProps {
    /** The signed-in user, on every page — or null. */
    auth: { user: { id: number; name: string; verified: boolean } | null };
    /** The languages of the switcher (the page's own is `usePage().locale`). */
    locales: readonly string[];
    /** The bell in the header: how many of the signed-in user's notifications are unread — null for guests. */
    bell: { unread: number } | null;
  }

  /**
   * The app's flash messages (E60): `redirect().flash('toast', { kind: 'success', message })` in a controller, a toast in the
   * layout (`useFlash('toast', …)`) — exactly once per message. No shared prop: the protocol carries them.
   */
  interface FlashData {
    toast: { kind: 'success' | 'error' | 'info'; message: string };
  }
}

/**
 * Shares what every page of the app shows (Inertia's `HandleInertiaRequests::share`).
 * Lazy: evaluated only when a page renders — redirects and JSON never look up the user.
 */
export class ShareAppProps {
  readonly #shared: SharedData;
  readonly #auth: Auth;
  readonly #locales: Locales;
  readonly #inbox: Inbox;

  constructor(shared: SharedData, auth: Auth, locales: Locales, inbox: Inbox) {
    this.#shared = shared;
    this.#auth = auth;
    this.#locales = locales;
    this.#inbox = inbox;
  }

  handle(_ctx: HttpContext, next: Next<{}>) {
    this.#shared
      .share('auth', async () => {
        // The same lookup authenticate() already made on this request (Auth is per request).
        const user = await this.#auth.user();
        return { user: user ? { id: user.id, name: user.name, verified: user.email_verified_at !== null } : null };
      })
      // One count per page, only when a page renders (and only this with `only: ['bell']`) — the list is its own page.
      .share('bell', async () => {
        const user = await this.#auth.user();
        return user ? { unread: await this.#inbox.count({ type: 'user', id: user.id }) } : null;
      })
      // The same list on every page (E64): sent with the first page, then kept by the browser — the server skips it while the
      // tab holds it. A language switch or signing in or out is a full load: it comes again then.
      .share('locales', once(() => this.#locales.supported));
    return next();
  }
}

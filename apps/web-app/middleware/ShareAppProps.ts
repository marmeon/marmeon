import { Auth } from '@bespokecore/auth';
import { SharedData, type HttpContext, type Next } from '@bespokecore/http';
import { Locales } from '@bespokecore/i18n';

declare module '@bespokecore/http/page' {
  interface SharedProps {
    /** The signed-in user, on every page — or null. */
    auth: { user: { id: number; name: string; verified: boolean } | null };
    /** The languages of the switcher (the page's own is `usePage().locale`). */
    locales: readonly string[];
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

  constructor(shared: SharedData, auth: Auth, locales: Locales) {
    this.#shared = shared;
    this.#auth = auth;
    this.#locales = locales;
  }

  handle(_ctx: HttpContext, next: Next<{}>) {
    this.#shared
      .share('auth', async () => {
        // The same lookup authenticate() already made on this request (Auth is per request).
        const user = await this.#auth.user();
        return { user: user ? { id: user.id, name: user.name, verified: user.email_verified_at !== null } : null };
      })
      .share('locales', this.#locales.supported);
    return next();
  }
}

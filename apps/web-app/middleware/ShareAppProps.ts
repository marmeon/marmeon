import { Auth } from '@bespokecore/auth';
import { SharedData, type HttpContext, type Next } from '@bespokecore/http';
import { Session } from '@bespokecore/session';

declare module '@bespokecore/http/page' {
  interface SharedProps {
    /** The signed-in user, on every page — or null. */
    auth: { user: { id: number; name: string } | null };
    /** Messages flashed by the previous request. */
    flash: { status: string | null };
  }
}

declare module '@bespokecore/session' {
  interface SessionData {
    /** Flash message for the next page (signed out, profile saved). */
    status: string;
  }
}

/**
 * Shares what every page of the app shows (Inertia's `HandleInertiaRequests::share`).
 * Lazy: evaluated only when a page renders — redirects and JSON never look up the user.
 */
export class ShareAppProps {
  readonly #shared: SharedData;
  readonly #session: Session;
  readonly #auth: Auth;

  constructor(shared: SharedData, session: Session, auth: Auth) {
    this.#shared = shared;
    this.#session = session;
    this.#auth = auth;
  }

  handle(_ctx: HttpContext, next: Next<{}>) {
    this.#shared
      .share('auth', async () => {
        // The same lookup authenticate() already made on this request (Auth is per request).
        const user = await this.#auth.user();
        return { user: user ? { id: user.id, name: user.name } : null };
      })
      .share('flash', () => ({ status: this.#session.get('status') ?? null }));
    return next();
  }
}

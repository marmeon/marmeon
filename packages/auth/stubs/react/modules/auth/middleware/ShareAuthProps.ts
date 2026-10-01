import { Auth } from '@bespokecore/auth';
import { SharedData, type HttpContext, type Next } from '@bespokecore/http';
import { Session } from '@bespokecore/session';

declare module '@bespokecore/http/page' {
  interface SharedProps {
    /** The signed-in user, on every page — or null. */
    auth: { user: { id: number; name: string; verified: boolean } | null };
    /** Messages flashed by the previous request. */
    flash: { status: string | null };
  }
}

declare module '@bespokecore/session' {
  interface SessionData {
    /** Flash message for the next page (signed out, password changed …). */
    status: string;
  }
}

/** Shares the signed-in user and flash messages with every page. Lazy: only pages ask. */
export class ShareAuthProps {
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
        const user = await this.#auth.user();
        return { user: user ? { id: user.id, name: user.name, verified: user.email_verified_at !== null } : null };
      })
      .share('flash', () => ({ status: this.#session.get('status') ?? null }));
    return next();
  }
}

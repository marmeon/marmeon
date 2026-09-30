import { SharedData, type HttpContext, type Next } from '@bespokecore/http';
import { Session } from '@bespokecore/session';
import { UserRepository } from '#modules/auth';

declare module '@bespokecore/http/page' {
  interface SharedProps {
    /** The signed-in user, on every page — or null. */
    auth: { user: { id: string; name: string } | null };
    /** Messages flashed by the previous request. */
    flash: { status: string | null };
  }
}

/**
 * Shares what every page of the app shows (Inertia's `HandleInertiaRequests::share`).
 * Lazy: evaluated only when a page renders — redirects and JSON never look up the user.
 */
export class ShareAppProps {
  readonly #shared: SharedData;
  readonly #session: Session;
  readonly #users: UserRepository;

  constructor(shared: SharedData, session: Session, users: UserRepository) {
    this.#shared = shared;
    this.#session = session;
    this.#users = users;
  }

  handle(_ctx: HttpContext, next: Next<{}>) {
    this.#shared
      .share('auth', () => {
        const user = this.#users.find(this.#session.get('user_id') ?? '');
        return { user: user ? { id: user.id, name: user.name } : null };
      })
      .share('flash', () => ({ status: this.#session.get('status') ?? null }));
    return next();
  }
}

import { Auth } from '@marmeon/auth';
import { SharedData, type HttpContext, type Next } from '@marmeon/http';

declare module '@marmeon/http/page' {
  interface SharedProps {
    /**
     * The signed-in user, on every page of the `web` group — or null. Optional on purpose: a path without a route (a 404)
     * passes no group's middleware, so its error page has no shared props — a layout around it renders without them.
     */
    auth?: { user: { id: number; name: string; verified: boolean } | null };
  }

  /**
   * Flash messages (E60): `redirect().flash('toast', { kind: 'success', message })` in a controller, shown once as a toast by
   * the layout (`useFlash('toast', …)`). Not a shared prop: the protocol carries them, exactly once.
   */
  interface FlashData {
    toast: { kind: 'success' | 'error' | 'info'; message: string };
  }
}

/** Shares the signed-in user with every page. Lazy: only pages ask. */
export class ShareAuthProps {
  readonly #shared: SharedData;
  readonly #auth: Auth;

  constructor(shared: SharedData, auth: Auth) {
    this.#shared = shared;
    this.#auth = auth;
  }

  handle(_ctx: HttpContext, next: Next<{}>) {
    this.#shared.share('auth', async () => {
      const user = await this.#auth.user();
      return { user: user ? { id: user.id, name: user.name, verified: user.email_verified_at !== null } : null };
    });
    return next();
  }
}

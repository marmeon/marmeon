import { Auth } from '@marmeon/auth';
import { once, SharedData, type HttpContext, type Next } from '@marmeon/http';
import { AppConfig } from '../../../config/app.ts';

declare module '@marmeon/http/page' {
  interface SharedProps {
    /**
     * The app's name (`APP_NAME`), for the layout's header. A once prop: the first page carries it, the browser keeps it. Optional
     * for the same reason as `auth`.
     */
    appName?: string;

    /**
     * The signed-in user, on every page of the `web` group — or null. Optional on purpose: a path without a route (a 404)
     * passes no group's middleware, so its error page has no shared props — a layout around it renders without them.
     * Shared props reach every page, in its HTML and its JSON: share only what pages show, so no id.
     */
    auth?: { user: { name: string; verified: boolean } | null };
  }

  /**
   * Flash messages: `redirect().flash('toast', { kind: 'success', message })` in a controller, shown once as a toast by
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
  readonly #app: AppConfig;

  constructor(shared: SharedData, auth: Auth, app: AppConfig) {
    this.#shared = shared;
    this.#auth = auth;
    this.#app = app;
  }

  handle(_ctx: HttpContext, next: Next<{}>) {
    this.#shared.share('appName', once(() => this.#app.name));
    this.#shared.share('auth', async () => {
      const user = await this.#auth.user();
      return { user: user ? { name: user.name, verified: user.email_verified_at !== null } : null };
    });
    return next();
  }
}

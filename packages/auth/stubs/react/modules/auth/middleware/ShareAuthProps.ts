import { Auth } from '@marmeon/auth';
import { once, SharedData, type HttpContext, type Next } from '@marmeon/http';
import { Router } from '@marmeon/router';
import { AppConfig } from '../../../config/app.ts';
import { HOME } from '../home.ts';

declare module '@marmeon/http/page' {
  interface SharedProps {
    /**
     * The app's name (`APP_NAME`), for the layout's header. A once prop: the first page carries it, the browser keeps it. Optional
     * for the same reason as `auth`.
     */
    appName?: string;

    /** The URL of {@link HOME}, where the layout's links to the app's home go. A once prop, optional like `appName`. */
    home?: string;

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

/** Shares the signed-in user, the app's name and the URL of HOME with every page. Lazy: only pages ask. */
export class ShareAuthProps {
  readonly #shared: SharedData;
  readonly #auth: Auth;
  readonly #app: AppConfig;
  readonly #router: Router;

  constructor(shared: SharedData, auth: Auth, app: AppConfig, router: Router) {
    this.#shared = shared;
    this.#auth = auth;
    this.#app = app;
    this.#router = router;
  }

  handle(_ctx: HttpContext, next: Next<{}>) {
    this.#shared.share('appName', once(() => this.#app.name));
    this.#shared.share('home', once(() => this.#router.url(HOME)));
    this.#shared.share('auth', async () => {
      const user = await this.#auth.user();
      return { user: user ? { name: user.name, verified: user.email_verified_at !== null } : null };
    });
    return next();
  }
}

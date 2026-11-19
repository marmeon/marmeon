import { devHosts, devOnly } from '@marmeon/core/dev';
import type { EmptyObject, HttpContext, Next } from '@marmeon/http';
import { AppConfig } from '../../config/app.ts';

/**
 * In front of every route of the local provider: a request for a host other than localhost, 127.0.0.1, [::1] and the host of `APP_URL` is a
 * 403, so a page of another site whose name was pointed at this machine (DNS rebinding) cannot start a flow or answer as a person. Every
 * answer carries the headers of a development route (`no-store`, same-origin resource and opener policies, no CORS). It reads `NODE_ENV`
 * from the process; `LocalOidc.provider()` asks the app's configuration as well, and both must pass.
 */
export class LocalOidcHost {
  readonly #guard: (ctx: HttpContext, next: Next<EmptyObject>) => Promise<Response>;

  constructor(app: AppConfig) {
    this.#guard = devOnly(devHosts(app.url), (_ctx: HttpContext, next: Next<EmptyObject>) => next());
  }

  handle(ctx: HttpContext, next: Next<EmptyObject>): Promise<Response> {
    return this.#guard(ctx, next);
  }
}

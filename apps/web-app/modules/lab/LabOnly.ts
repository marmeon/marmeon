import { abort, type HttpContext, type Next } from '@marmeon/http';
import { LabConfig } from './config.ts';

/** In front of every lab route: a 404 unless the lab is on, before the route's own limit counts, its binder looks a record up or a guest is sent to the sign-in page. */
export class LabOnly {
  readonly #enabled: boolean;

  constructor(config: LabConfig) {
    this.#enabled = config.enabled;
  }

  handle(_ctx: HttpContext, next: Next<{}>) {
    if (!this.#enabled) abort(404);
    return next();
  }
}

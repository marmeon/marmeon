import { abort, type HttpContext, type Next } from '@marmeon/http';
import { LabConfig } from './config.ts';

/** In front of a lab route that signs users in: a 404 unless the lab is on, before a guest is sent to the sign-in page or a limit answers. */
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

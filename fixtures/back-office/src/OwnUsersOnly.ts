import type { HttpContext, Next } from '@marmeon/http';
import { abort } from '@marmeon/http';
import { BackOfficeConfig } from './BackOfficeConfig.ts';

/**
 * In front of the guard's middleware on the routes of the mode `own`: the routes exist in both modes, so the app's route list never depends on
 * `BACK_OFFICE_USERS`, and in the mode `app` they answer 404 before anything looks at a session.
 */
export class OwnUsersOnly {
  static readonly inject = [BackOfficeConfig] as const;

  readonly #config: BackOfficeConfig;

  constructor(config: BackOfficeConfig) {
    this.#config = config;
  }

  handle(_ctx: HttpContext, next: Next<{}>) {
    if (this.#config.users !== 'own') abort(404);
    return next();
  }
}

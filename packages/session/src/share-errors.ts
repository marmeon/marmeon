import { always, SharedData, type ValidationErrors } from '@bespokecore/http';
import type { HttpContext, Next } from '@bespokecore/router';
import { Session } from './session.ts';

declare module '@bespokecore/http/page' {
  interface SharedProps {
    /** Validation errors of the previous request, `{}` if none — what `useForm` shows next to the fields. */
    errors: ValidationErrors;
  }
}

/**
 * Shares the flashed validation errors with every page of the `web` group (the Inertia pattern) — with every
 * partial reload, too (`always`): a form sent with `only` that fails comes back with its errors.
 */
export class ShareErrorsFromSession {
  readonly #session: Session;
  readonly #shared: SharedData;

  constructor(session: Session, shared: SharedData) {
    this.#session = session;
    this.#shared = shared;
  }

  handle(_ctx: HttpContext, next: Next<{}>) {
    this.#shared.share('errors', always(() => this.#session.get('errors') ?? {}));
    return next();
  }
}

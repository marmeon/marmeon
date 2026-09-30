import { Logger, token } from '@bespokecore/core';
import { expectsJson, HttpError, statusText, ValidationError } from '@bespokecore/router';
import { ERROR_PAGE, PAGE_HEADER, type ErrorPageProps } from './page.ts';
import { RedirectResult } from './redirect.ts';
import { view } from './view.ts';

// HttpError and abort() live in the router (the request parser throws them too); re-exported for apps.
export { abort, HttpError } from '@bespokecore/router';

/**
 * Decides what happens with errors — Laravel's exception handler. Bound as a
 * token, so apps replace it by binding their own class.
 */
export interface ExceptionHandler {
  /** Records the error (logs it). Client errors (4xx) are not reported. */
  report(error: unknown): void;
  /** Turns the error into a result: a view for pages and navigations, JSON for APIs. */
  render(error: unknown, request: Request, options: { debug: boolean }): unknown;
}
export const ExceptionHandler = token<ExceptionHandler>('ExceptionHandler');

export class DefaultExceptionHandler implements ExceptionHandler {
  readonly #logger: Logger;

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  report(error: unknown): void {
    if (error instanceof HttpError && error.status < 500) return;
    const { name, message, stack } = asError(error);
    this.#logger.error(message, { exception: name, stack });
  }

  render(error: unknown, request: Request, { debug }: { debug: boolean }): unknown {
    if (error instanceof ValidationError) return renderInvalid(error, request);
    const status = error instanceof HttpError ? error.status : 500;
    const title = statusText(status);
    const exposed = error instanceof HttpError || debug;
    const message = exposed ? asError(error).message : title;
    // A deliberate abort(4xx) is not a bug: no stack trace, not even in debug mode (like Laravel).
    const exception = debug && status >= 500 ? asError(error) : null;
    const headers = error instanceof HttpError ? error.headers : {};

    if (wantsPage(request)) {
      const props: ErrorPageProps = { status, title, message, exception };
      return view(ERROR_PAGE, { ...props }, status, headers);
    }
    return Response.json(exception ? { message, exception } : { message }, { status, headers });
  }
}

/**
 * Invalid input: clients that expect JSON get 422 with the field errors; everyone
 * else goes back to the form, with the errors and the old input in the session —
 * the form shows them next to the fields (Laravel's rule, and the Inertia pattern).
 */
function renderInvalid(error: ValidationError, request: Request): unknown {
  if (expectsJson(request)) {
    return Response.json({ message: error.message, errors: error.errors }, { status: 422 });
  }
  return new RedirectResult().back().withErrors(error.errors).withInput(error.input);
}

/** Page loads and client-side navigations get an error page; everything else JSON. */
function wantsPage(request: Request): boolean {
  return request.headers.get(PAGE_HEADER) === 'true' || (request.headers.get('accept') ?? '').includes('text/html');
}

function asError(error: unknown): { name: string; message: string; stack: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack ?? '' }
    : { name: 'Error', message: String(error), stack: '' };
}

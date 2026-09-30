import { Logger, token } from '@bespokecore/core';
import { ERROR_PAGE, PAGE_HEADER, type ErrorPageProps } from './page.ts';
import { view } from './view.ts';

const REASONS: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  419: 'Page Expired',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Server Error',
  503: 'Service Unavailable',
};

/** An error that maps to an HTTP status. Its message is meant for the client. */
export class HttpError extends Error {
  override name = 'HttpError';
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;

  constructor(status: number, message = REASONS[status] ?? 'Error', headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

/** Laravel's `abort(404)`: stops handling and answers with that status — from controllers or middleware. */
export function abort(status: number, message?: string, headers?: Record<string, string>): never {
  throw new HttpError(status, message, headers);
}

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
    const status = error instanceof HttpError ? error.status : 500;
    const title = REASONS[status] ?? 'Error';
    const exposed = error instanceof HttpError || debug;
    const message = exposed ? asError(error).message : title;
    // A deliberate abort(4xx) is not a bug: no stack trace, not even in debug mode (like Laravel).
    const exception = debug && status >= 500 ? asError(error) : null;
    const headers = error instanceof HttpError ? error.headers : {};

    if (wantsPage(request)) {
      const props: ErrorPageProps = { status, title, message, exception };
      return view(ERROR_PAGE, { ...props }, status);
    }
    return Response.json(exception ? { message, exception } : { message }, { status, headers });
  }
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

import { Logger, Redactor, token, type Translator } from '@marmeon/core';
import { expectsJson, HttpError, statusText, ValidationError } from '@marmeon/router';
import { ERROR_PAGE, PAGE_HEADER, type ErrorPageProps } from './page.ts';
import { RedirectResult } from './redirect.ts';
import { view } from './view.ts';

// HttpError and abort() live in the router (the request parser throws them too); re-exported for apps.
export { abort, HttpError } from '@marmeon/router';

/**
 * Decides what happens with errors: reports and renders them. Bound as a
 * token, so apps replace it by binding their own class.
 */
export interface ExceptionHandler {
  /** Records the error (logs it). Client errors (4xx) are not reported. */
  report(error: unknown): void;
  /**
   * Turns the error into a result: a view for pages and navigations, JSON for APIs — in the request's language when
   * a `translator` is given (the kernel passes the request's, when @marmeon/i18n binds one).
   */
  render(error: unknown, request: Request, options: ExceptionRenderOptions): unknown;
}

export interface ExceptionRenderOptions {
  debug: boolean;
  /** The request's translator (`Translator` of @marmeon/core); without one, texts stay in English. */
  translator?: Translator;
}
export const ExceptionHandler = token<ExceptionHandler>('ExceptionHandler');

export class DefaultExceptionHandler implements ExceptionHandler {
  readonly #logger: Logger;
  readonly #redactor: Redactor;

  constructor(logger: Logger, redactor: Redactor) {
    this.#logger = logger;
    this.#redactor = redactor;
  }

  report(error: unknown): void {
    if (error instanceof HttpError && error.status < 500) return;
    const { name, message, stack } = asError(error);
    // The message is the log line's own text, the stack a string: masked like text by the app's Redactor — keys alone would
    // not catch a connection URL or a token an error quotes, and the core's list alone not the names packages add (the session cookie).
    this.#logger.error(this.#redactor.text(message), { exception: name, stack: this.#redactor.text(stack) });
  }

  render(error: unknown, request: Request, { debug, translator }: ExceptionRenderOptions): unknown {
    if (error instanceof ValidationError) return renderInvalid(translator ? error.translate(translator) : error, request);
    const status = error instanceof HttpError ? error.status : 500;
    // Framework texts by key (`marmeon.status.404`), English without a translator.
    const title = translator ? translator.text(`marmeon.status.${status}`, {}, statusText(status)) : statusText(status);
    const exposed = error instanceof HttpError || debug;
    const translation = error instanceof HttpError ? error.translation : undefined;
    // An error's own message may be a key too: `abort(403, 'auth.verify.wrong_account')`, `deny('…')` of a policy.
    const raw = asError(error).message;
    const message = !exposed
      ? title
      : translator && translation
        ? translator.text(translation.key, translation.params, raw)
        : translator?.has(raw)
          ? translator.text(raw)
          : raw;
    // A deliberate abort(4xx) is not a bug: no stack trace, not even in debug mode.
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
 * the form shows them next to the fields.
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

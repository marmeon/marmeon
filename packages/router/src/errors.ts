const REASONS: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  413: 'Content Too Large',
  415: 'Unsupported Media Type',
  419: 'Page Expired',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Server Error',
  503: 'Service Unavailable',
};

/** `404` → `Not Found`. */
export function statusText(status: number): string {
  return REASONS[status] ?? 'Error';
}

/**
 * A text by translation key (`namespace.path`), with the values of its placeholders — what a translator
 * (`Translator` of @marmeon/core, bound by @marmeon/i18n) turns into the request's language.
 */
export interface TextKey {
  readonly key: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

/**
 * An error that maps to an HTTP status. Its message is meant for the client — in English; `translation` names
 * the key the exception handler shows instead when a translator is bound (framework errors carry one; without
 * a message, the status text's: `marmeon.status.404`).
 */
export class HttpError extends Error {
  override name = 'HttpError';
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly translation: TextKey | undefined;

  constructor(status: number, message?: string, headers: Record<string, string> = {}, translation?: TextKey) {
    super(message ?? statusText(status));
    this.status = status;
    this.headers = headers;
    this.translation = translation ?? (message === undefined ? { key: `marmeon.status.${status}` } : undefined);
  }
}

/** Laravel's `abort(404)`: stops handling and answers with that status — from controllers or middleware. */
export function abort(status: number, message?: string, headers?: Record<string, string>): never {
  throw new HttpError(status, message, headers);
}

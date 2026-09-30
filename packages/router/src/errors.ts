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

/** An error that maps to an HTTP status. Its message is meant for the client. */
export class HttpError extends Error {
  override name = 'HttpError';
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;

  constructor(status: number, message = statusText(status), headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

/** Laravel's `abort(404)`: stops handling and answers with that status — from controllers or middleware. */
export function abort(status: number, message?: string, headers?: Record<string, string>): never {
  throw new HttpError(status, message, headers);
}

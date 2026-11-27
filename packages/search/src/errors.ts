/**
 * Thrown at the start for a search setup that cannot work, such as a `SEARCH_DRIVER` nobody brought or a driver name a provider may
 * not use. Its message starts with the code `Q9`. See `docs/errors.md#server-error-codes`.
 */
export class SearchSetupError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SearchSetupError';
  }
}

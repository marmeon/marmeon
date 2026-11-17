/**
 * Why a request did not complete: `refused` (the address policy, or a request that cannot be sent: a malformed header or method,
 * a scheme other than http and https, credentials in the address, a redirect to http from https), `timeout` (a time limit ran out,
 * the reading of the body included), `aborted` (the caller's own signal; its reason is the `cause`), `network` (resolution,
 * connection or transfer failed), `too-large` (the response is bigger than `maxResponseBytes`) or `redirects` (more redirects than
 * `maxRedirects`, or any redirect with `redirect: 'error'`).
 */
export type FetchErrorReason = 'refused' | 'timeout' | 'aborted' | 'network' | 'too-large' | 'redirects';

/** Thrown when a request is refused or fails. The address a host resolved to is in `cause`, never in the message. */
export class FetchError extends Error {
  readonly reason: FetchErrorReason;

  constructor(reason: FetchErrorReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FetchError';
    this.reason = reason;
  }
}

/**
 * Thrown at the start for a `FETCH_ALLOWED_ADDRESSES` entry that is not a range, a `FETCH_DRIVER` nobody brought, or a factory
 * that returns no transport. Its message starts with the code `S9`. A name a provider brings twice or wrongly stops the start with a `TypeError`.
 */
export class FetchSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FetchSetupError';
  }
}

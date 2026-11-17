/**
 * Why a request did not complete: `refused` (the address policy, or a request that cannot be sent: a malformed header or method,
 * a scheme other than http and https, credentials in the address), `timeout` (a time limit ran out), `aborted` (the caller's own
 * signal; its reason is the `cause`) or `network` (resolution, connection or transfer failed).
 */
export type FetchErrorReason = 'refused' | 'timeout' | 'aborted' | 'network';

/** Thrown when a request is refused or fails. The address a host resolved to is in `cause`, never in the message. */
export class FetchError extends Error {
  readonly reason: FetchErrorReason;

  constructor(reason: FetchErrorReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FetchError';
    this.reason = reason;
  }
}

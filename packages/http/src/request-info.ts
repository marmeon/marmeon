import { token } from '@marmeon/core';

/**
 * Who sent the current request — injectable where `ctx` is not at hand: `Auth` puts it into the `Login` event, a
 * service may log it. Bound per request by the server kernel; outside a request (a job, a command) both are undefined.
 */
export interface RequestInfo {
  /** The client's address — through the proxies the app trusts (`SERVER_TRUSTED_PROXIES`), like `ctx.ip`. */
  readonly ip: string | undefined;
  /** The `User-Agent` header, as the client sent it (anyone can send anything here — show it, never trust it). */
  readonly userAgent: string | undefined;
}
export const RequestInfo = token<RequestInfo>('RequestInfo');

/** What `RequestInfo` is outside a request. */
export const NO_REQUEST_INFO: RequestInfo = Object.freeze({ ip: undefined, userAgent: undefined });

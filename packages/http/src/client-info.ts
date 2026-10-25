import { token } from '@marmeon/core';

/**
 * Who sent the current request — injectable where `ctx` is not at hand: `Auth` puts it into the `SignedIn` event, a
 * service may log it. Bound per request by the server kernel; outside a request (a job, a command) both are undefined.
 */
export interface ClientInfo {
  /** The client's address — through the proxies the app trusts (`SERVER_TRUSTED_PROXIES`), like `ctx.ip`. */
  readonly ip: string | undefined;
  /** The `User-Agent` header, as the client sent it (anyone can send anything here — show it, never trust it). */
  readonly userAgent: string | undefined;
}
export const ClientInfo = token<ClientInfo>('ClientInfo');

/** What `ClientInfo` is outside a request. */
export const NO_CLIENT_INFO: ClientInfo = Object.freeze({ ip: undefined, userAgent: undefined });

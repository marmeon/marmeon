import { token, type Logger, type Resolver } from '@marmeon/core';

/** What a transport sends: one request, to one URL. The client has checked the scheme and follows redirects itself. */
export type TransportRequest = {
  readonly url: URL;
  readonly method: string;
  /** Lowercase names. */
  readonly headers: Readonly<Record<string, string>>;
  /** Buffered, so that a redirect can send it again. */
  readonly body?: string | Uint8Array;
};

/** What a transport returns: the status, the headers and the body as the server sent them, no redirect followed. */
export type TransportResponse = {
  readonly status: number;
  readonly headers: Headers;
  readonly body: ReadableStream<Uint8Array>;
};

/** What the client hands a transport with every request. */
export type TransportContext = {
  /** Whether a resolved address (`"93.184.216.34"`, `"2001:db8::1"`) may be connected to: it is public, or in a range `FETCH_ALLOWED_ADDRESSES` or `allowing()` names. */
  isPublic(address: string): boolean;
  /** In milliseconds: the limit for name resolution and connect, and for the wait for the response headers. */
  readonly timeouts: { readonly connect: number; readonly response: number };
  /** Aborts the request at any stage, the reading of its body included. Its reason is the cause of the failure. */
  readonly signal: AbortSignal;
};

/**
 * Sends one request and returns its response. A transport resolves the host and connects itself, and refuses an address that is
 * not allowed (`context.isPublic`) with a `FetchError`: `direct` connects only to the addresses it checked. A transport that hands the
 * connection to an egress proxy hands the check to that proxy too, and has to say so. It throws a `FetchError` and nothing else,
 * also for the body stream of the response.
 */
export interface FetchTransport {
  send(request: TransportRequest, context: TransportContext): Promise<TransportResponse>;
  /** Closes connections the transport holds; the framework calls it at shutdown, when the transport was built. */
  close?(): Promise<void>;
}
export const FetchTransport = token<FetchTransport>('FetchTransport');

/** What a {@link FetchDriverFactory} is given. */
export interface FetchDriverContext {
  /** The name the driver was registered under (`FETCH_DRIVER=egress`). */
  readonly name: string;
  readonly container: Resolver;
  /** Writes to the log on the `fetch` channel. */
  readonly logger: Logger;
}

/** Creates a fetch transport: `static fetchDrivers = { egress: (context) => … }` on a service provider. */
export type FetchDriverFactory = (context: FetchDriverContext) => FetchTransport;

import { isIP } from 'node:net';
import { durationToMilliseconds, type Duration } from '@marmeon/core';
import { isPublic, parseAddress, parseRange, type AddressRange } from './addresses.ts';
import { FetchError } from './errors.ts';
import type { FetchTransport } from './transport.ts';

type BodyOptions =
  | {
      /** A `URLSearchParams` is sent as a form. Not with `json`. */
      readonly body?: string | Uint8Array | URLSearchParams;
      readonly json?: undefined;
    }
  | {
      /** Sent as JSON with `content-type: application/json`. Not with `body`. */
      readonly json: unknown;
      readonly body?: undefined;
    };

/**
 * What `HttpClient.fetch` accepts besides the address. A header that frames or routes the request (`content-length`,
 * `transfer-encoding`, `connection`, `upgrade`, `te`, `trailer`, `keep-alive`, `expect`, `host`, `proxy-*`) is the transport's to
 * set, so passing one is a `TypeError`. An address with a user name or a password is refused (`FetchError`, `refused`), as is a redirect to one. On a redirect to another origin only `accept`, `accept-language` and `user-agent` are
 * sent on (an API key or a token never follows), and a redirect to another origin that would send the body again (any redirect that keeps the method, such as 307, 308, or a 301/302 of a PUT or DELETE) is refused.
 */
export type FetchOptions = BodyOptions & {
  /** Default `GET`. */
  readonly method?: string;
  readonly headers?: Headers | Readonly<Record<string, string>>;
  /** For the whole request: every redirect and the reading of the body. A number is seconds. Default 15 seconds, at most 2147483647 milliseconds. */
  readonly timeout?: Duration;
  /** The largest response body, in bytes. Default 5 MiB. `fetch()` itself throws `too-large` when the declared `content-length` is above it; a body that grows past it fails when it is read. */
  readonly maxResponseBytes?: number;
  /** `follow` (default) follows redirects up to `maxRedirects`, `manual` returns the redirect, `error` throws when the response redirects. */
  readonly redirect?: 'follow' | 'manual' | 'error';
  /** Default 3. */
  readonly maxRedirects?: number;
  /** Aborts the request at any stage. */
  readonly signal?: AbortSignal;
};

export type HttpClientOptions = {
  readonly transport: FetchTransport;
  /** Ranges (`10.20.0.0/16`) that may be reached although they are not public. Throws a `TypeError` for an entry that is not a range. */
  readonly allow?: readonly string[];
};

const DEFAULT_TIMEOUT = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;
const CONNECT_TIMEOUT = 5_000;
const RESPONSE_TIMEOUT = 10_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
// A response with one of these statuses has no body, whatever its Content-Length says; so has a response to HEAD (the `method === 'HEAD'` check).
const NO_BODY_STATUSES = new Set([204, 205, 304]);
const CROSS_ORIGIN_HEADERS = new Set(['accept', 'accept-language', 'user-agent']);
const TRANSPORT_HEADERS = new Set(['content-length', 'transfer-encoding', 'connection', 'upgrade', 'te', 'trailer', 'keep-alive', 'expect', 'host']);
const MAX_TIMER = 2_147_483_647;
const METHOD_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const BODY_HEADERS = ['content-type', 'content-encoding', 'content-language', 'content-location'];
const FORBIDDEN_METHODS = new Set(['CONNECT', 'TRACE', 'TRACK']);
const NORMALIZED_METHODS = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'POST', 'PUT']);

function positive(name: string, value: number | undefined, fallback: number, integer: boolean, max = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0 || value > max || (integer && !Number.isInteger(value))) {
    throw new TypeError(`${name} must be a positive ${integer ? 'whole ' : ''}number.`);
  }
  return value;
}

/** Checks the scheme and the credentials of an address, the one passed in and every redirect target: an address is data, so a refusal is a `FetchError`. */
function checkUrl(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new FetchError('refused', 'Only http and https addresses can be fetched.');
  if (url.username !== '' || url.password !== '') {
    throw new FetchError('refused', 'The address carries a user name or a password. Send credentials in a header instead.');
  }
}

type Body = { readonly body: string | Uint8Array | undefined; readonly type: string | undefined };

function encodeBody(options: FetchOptions): Body {
  if (options.json !== undefined && options.body !== undefined) throw new TypeError('Pass either body or json, not both.'); // also for a JS caller
  if (options.json !== undefined) {
    const text = JSON.stringify(options.json);
    if (text === undefined) throw new TypeError('json must be a value that JSON can represent.');
    return { body: text, type: 'application/json' };
  }
  const { body } = options;
  if (body instanceof URLSearchParams) return { body: body.toString(), type: 'application/x-www-form-urlencoded;charset=UTF-8' };
  if (typeof body === 'string' || body instanceof Uint8Array || body === undefined) return { body, type: undefined };
  throw new TypeError('body must be a string, a Uint8Array or a URLSearchParams.');
}

const wrap = (value: Response, url: string, redirected: boolean): Response => {
  Object.defineProperty(value, 'url', { value: url });
  Object.defineProperty(value, 'redirected', { value: redirected });
  const clone = value.clone.bind(value);
  Object.defineProperty(value, 'clone', { value: () => wrap(clone(), url, redirected) });
  return value;
};

/**
 * Sends requests to other servers and refuses the ones that would reach your own network. The client checks the address of a
 * host written as an IP address, the scheme and the credentials of the address at every hop of a redirect; the transport resolves a
 * host name, checks every address it resolves to and connects only to a checked one (`direct` does). See `FetchTransport`.
 */
export class HttpClient {
  readonly #transport: FetchTransport;
  readonly #text: readonly string[];
  readonly #allow: readonly AddressRange[];

  /** @internal The `FetchServiceProvider` makes the client the container hands out; `HttpClientFake` extends it. */
  constructor(options: HttpClientOptions) {
    this.#transport = options.transport;
    this.#text = Object.freeze([...(options.allow ?? [])]);
    this.#allow = this.#text.map(parseRange);
  }

  /**
   * A client that may also reach `ranges` (CIDR ranges such as `10.20.0.0/16`, never host names), for one integration. The client it
   * is called on stays as it was. Throws a `TypeError` for an entry that is not a range.
   */
  allowing(ranges: readonly string[]): HttpClient {
    return new HttpClient({ transport: this.#transport, allow: [...this.#text, ...ranges] });
  }

  #permits(address: string): boolean {
    const parsed = parseAddress(address);
    return parsed !== undefined && isPublic(parsed, this.#allow);
  }

  /** A host written as an IP address is checked here, whatever the transport does. */
  #checkLiteral(url: URL): void {
    const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
    if (isIP(host) !== 0 && !this.#permits(host)) throw new FetchError('refused', 'The host is an address that is not public.');
  }

  /**
   * Fetches `input` and returns a standard `Response` — a 4xx or a 5xx is a response, not an error. Throws a `FetchError` when the
   * request is refused, times out, fails, is aborted, is redirected more often than allowed or, with `redirect: 'error'`, is
   * redirected at all; a body that grows past `maxResponseBytes` or is read past the deadline fails when it is read. Throws a
   * `TypeError` for options that cannot be sent. Read or cancel the body: it holds the connection until then.
   */
  async fetch(input: string | URL, options: FetchOptions = {}): Promise<Response> {
    let url = new URL(input);
    checkUrl(url);
    const timeout = positive('timeout', options.timeout === undefined ? undefined : durationToMilliseconds(options.timeout), DEFAULT_TIMEOUT, false, MAX_TIMER);
    const maxBytes = positive('maxResponseBytes', options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, true);
    const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    if (!Number.isInteger(maxRedirects) || maxRedirects < 0) throw new TypeError('maxRedirects must be a whole number of 0 or more.');
    const redirect = options.redirect ?? 'follow';
    if (redirect !== 'follow' && redirect !== 'manual' && redirect !== 'error') throw new TypeError("redirect must be 'follow', 'manual' or 'error'.");
    const given = options.method ?? 'GET';
    if (!METHOD_TOKEN.test(given)) throw new TypeError('method must be an HTTP method name.');
    const upper = given.toUpperCase();
    if (FORBIDDEN_METHODS.has(upper)) throw new TypeError('This method cannot be sent.');
    let method = NORMALIZED_METHODS.has(upper) ? upper : given;
    const encoded = encodeBody(options);
    if (encoded.body !== undefined && (method === 'GET' || method === 'HEAD')) throw new TypeError('A GET or HEAD request has no body.');
    let body = encoded.body;
    let headers: Record<string, string> = Object.create(null);
    for (const [name, value] of new Headers(options.headers as Record<string, string> | undefined)) {
      if (TRANSPORT_HEADERS.has(name) || name.startsWith('proxy-')) {
        throw new TypeError('A header that frames or routes the request (content-length, host, connection, proxy-*, …) is set by the transport, not by the caller.');
      }
      headers[name] = value;
    }
    if (encoded.type !== undefined && headers['content-type'] === undefined) headers['content-type'] = encoded.type;

    const deadline = new AbortController();
    // Before the timer: a `signal` that is not an AbortSignal throws here and leaves nothing running.
    const signal = options.signal ? AbortSignal.any([deadline.signal, options.signal]) : deadline.signal;
    const timer = setTimeout(() => deadline.abort(new FetchError('timeout', 'The request did not complete in time.')), timeout);
    const done = () => clearTimeout(timer);
    // The caller's abort and the deadline reach the transport as one signal; this says which of them it was.
    const classify = (error: unknown): FetchError => {
      if (error instanceof FetchError && error.reason !== 'aborted' && error.reason !== 'timeout' && error.reason !== 'network') return error;
      if (options.signal?.aborted) return new FetchError('aborted', 'The request was aborted.', { cause: options.signal.reason });
      if (deadline.signal.aborted) return new FetchError('timeout', 'The request did not complete in time.');
      return error instanceof FetchError ? error : new FetchError('network', 'The request failed.', { cause: error });
    };
    // The limits hold for a transport that ignores its signal: the wait ends with the signal, the transport's work is left behind.
    const race = <T>(promise: Promise<T>): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        if (signal.aborted) {
          promise.catch(() => {});
          reject(classify(signal.reason));
          return;
        }
        const onAbort = () => reject(classify(signal.reason));
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
          (value) => {
            signal.removeEventListener('abort', onAbort);
            resolve(value);
          },
          (error: unknown) => {
            signal.removeEventListener('abort', onAbort);
            reject(error);
          },
        );
      });
    const context = {
      isPublic: (address: string) => this.#permits(address),
      timeouts: { connect: Math.min(CONNECT_TIMEOUT, timeout), response: Math.min(RESPONSE_TIMEOUT, timeout) },
      signal,
    };

    try {
      for (let followed = 0; ; followed++) {
        this.#checkLiteral(url);
        if (signal.aborted) throw classify(signal.reason);
        const sending = Promise.resolve().then(() => this.#transport.send({ url, method, headers, body }, context));
        // A response that arrives after the signal won the race is not used: its connection is closed.
        sending.then(
          (late) => {
            if (signal.aborted) void late.body.cancel().catch(() => {});
          },
          () => {},
        );
        const response = await race(sending).catch((error: unknown) => {
          throw classify(error);
        });
        const location = response.headers.get('location');
        const redirects = REDIRECT_STATUSES.has(response.status);
        if (redirects && redirect === 'error') {
          void response.body.cancel().catch(() => {});
          throw new FetchError('redirects', "The server answered with a redirect, and redirect is 'error'.");
        }
        if (!redirects || location === null || redirect === 'manual') {
          return await this.#respond(response, method, url, followed > 0, maxBytes, { done, classify, race });
        }
        await race(response.body.cancel()).catch((error: unknown) => {
          if (error instanceof FetchError) throw error;
        });
        if (followed >= maxRedirects) throw new FetchError('redirects', `The request was redirected more than ${maxRedirects} times.`);
        let next: URL;
        try {
          next = new URL(location, url);
        } catch (error) {
          throw new FetchError('network', 'The server redirected to an address that is not valid.', { cause: error });
        }
        checkUrl(next);
        if (url.protocol === 'https:' && next.protocol === 'http:') throw new FetchError('refused', 'A redirect from https to http is refused.');
        const { status } = response;
        if (status === 303 ? method !== 'GET' && method !== 'HEAD' : (status === 301 || status === 302) && method === 'POST') {
          method = 'GET';
          body = undefined;
          headers = { ...headers };
          for (const name of BODY_HEADERS) delete headers[name];
        }
        if (next.origin !== url.origin) {
          if (body !== undefined) throw new FetchError('refused', 'A redirect to another origin that would send the body again is refused.');
          headers = Object.fromEntries(Object.entries(headers).filter(([name]) => CROSS_ORIGIN_HEADERS.has(name)));
        }
        url = next;
      }
    } catch (error) {
      done();
      throw classify(error);
    }
  }

  /** Wraps the body in the size limit and the deadline, and ends the deadline's timer when the body ends. */
  async #respond(
    response: { readonly status: number; readonly headers: Headers; readonly body: ReadableStream<Uint8Array> },
    method: string,
    url: URL,
    redirected: boolean,
    maxBytes: number,
    control: { done: () => void; classify: (error: unknown) => FetchError; race: <T>(promise: Promise<T>) => Promise<T> },
  ): Promise<Response> {
    const { done, classify, race } = control;
    const { status, headers } = response;
    const reader = response.body.getReader();
    if (status < 200 || status > 599) {
      void reader.cancel().catch(() => {});
      throw new FetchError('network', 'The server answered with a status that is not a response.');
    }
    if (method === 'HEAD' || NO_BODY_STATUSES.has(status)) {
      void reader.cancel().catch(() => {});
      done();
      return wrap(new Response(null, { status, headers }), url.href, redirected);
    }
    const declared = headers.get('content-length');
    if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
      void reader.cancel().catch(() => {});
      throw new FetchError('too-large', 'The response is larger than maxResponseBytes.');
    }
    let total = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await race(reader.read());
          if (next.done) {
            done();
            controller.close();
            return;
          }
          total += next.value.byteLength;
          if (total > maxBytes) throw new FetchError('too-large', 'The response is larger than maxResponseBytes.');
          controller.enqueue(next.value);
        } catch (error) {
          done();
          void reader.cancel().catch(() => {});
          controller.error(classify(error));
        }
      },
      cancel(reason) {
        done();
        return reader.cancel(reason);
      },
    });
    return wrap(new Response(stream, { status, headers }), url.href, redirected);
  }
}

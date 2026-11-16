import { AssertionError } from 'node:assert';
import { isIP } from 'node:net';
import { allowedRanges } from './allowed.ts';
import { HttpClient } from './client.ts';
import { FetchError, type FetchErrorReason } from './errors.ts';
import type { FetchTransport, TransportContext, TransportRequest, TransportResponse } from './transport.ts';

/** What `respond()` and the assertions match a request by: an address, written as `fetch` normalises it (a text that is no address is a `TypeError`), a pattern for the address, or a function of the request. */
export type RequestMatch = string | RegExp | ((request: Request) => boolean);

/**
 * What a request gets back: a `Response` or a function that makes one. A static `Response` is read once, when it first answers, and
 * copied for every request, so its body must end; a body that streams belongs in a function reply
 * (`(request) => new Response(stream, …)`), which makes a new response for every request.
 */
export type FakeReply = Response | ((request: Request) => Response | Promise<Response>);

const LOOPBACK = ['127.0.0.1', '::1'];

const matches = (match: RequestMatch, request: Request): boolean =>
  typeof match === 'string' ? request.url === match : match instanceof RegExp ? new RegExp(match.source, match.flags.replace(/[gy]/g, '')).test(request.url) : match(request.clone());

/** A string match is an address: written as `fetch` normalises it, so `https://A.example.com` matches what is sent. A text that is no address is a `TypeError`. */
const normalised = (match: RequestMatch): RequestMatch => (typeof match === 'string' ? new URL(match).href : match);

/** A host as the policy sees it: punycode, lower case, without brackets or a trailing dot. A text that is no host is a `TypeError`. */
function hostKey(host: string): string {
  const bracketed = host.startsWith('[') && host.endsWith(']');
  if (/[\s/?#@]/.test(host) || (!bracketed && host.includes(':'))) throw new TypeError(`dns() takes a bare host name or IP address, without a port, user, path, query or fragment: not "${host}".`);
  const { hostname } = new URL(`http://${host}`);
  return (hostname.startsWith('[') ? hostname.slice(1, -1) : hostname).replace(/\.$/, '');
}

const describeRequest = (request: Request): string => `${request.method} ${request.url}`;

const MESSAGES: Record<FetchErrorReason, string> = {
  refused: 'The request was refused.',
  timeout: 'The request did not complete in time.',
  aborted: 'The request was aborted.',
  network: 'The request failed.',
  'too-large': 'The response is larger than maxResponseBytes.',
  redirects: 'The request was redirected more often than allowed.',
};

/** Applies the address policy, records the request and answers it from the registered replies; never opens a connection. */
class FakeTransport implements FetchTransport {
  readonly requests: Request[] = [];
  readonly replies: { match: RequestMatch; reply: FakeReply; template?: Promise<{ status: number; headers: [string, string][]; bytes: Uint8Array<ArrayBuffer> }> }[] = [];
  readonly names = new Map<string, readonly string[]>();
  readonly failures: FetchErrorReason[] = [];

  async send(request: TransportRequest, context: TransportContext): Promise<TransportResponse> {
    this.#judge(request.url, context);
    // A body is a string or bytes, which `RequestInit` takes; its lib types name them differently.
    const recorded = new Request(request.url, { method: request.method, headers: { ...request.headers }, body: request.body as RequestInit['body'] });
    // The request as it was sent: `Request` infers a content type for a string body, which the transport never sends.
    if (request.headers['content-type'] === undefined) recorded.headers.delete('content-type');
    this.requests.push(recorded);
    const failure = this.failures.shift();
    if (failure) throw new FetchError(failure, MESSAGES[failure]);
    // The latest respond() that matches wins, so a test can override what a helper registered.
    const entry = this.replies.findLast((candidate) => matches(candidate.match, recorded));
    if (!entry) throw new FetchError('network', `no fake response for ${describeRequest(recorded)} — add app.http.respond(…)`);
    const response = typeof entry.reply === 'function' ? await entry.reply(recorded.clone()) : await this.#fresh(entry);
    return { status: response.status, headers: response.headers, body: response.body ?? new ReadableStream({ start: (controller) => controller.close() }) };
  }

  /**
   * A new `Response` of a static reply for every request, built from its bytes: cloning would tee the body, and cancelling a branch
   * (as the client does for a redirect) waits for the template's branch, which nobody reads.
   */
  async #fresh(entry: (typeof this.replies)[number]): Promise<Response> {
    const reply = entry.reply as Response;
    entry.template ??= reply.clone().arrayBuffer().then((buffer) => ({ status: reply.status, headers: [...reply.headers], bytes: new Uint8Array<ArrayBuffer>(buffer) }));
    const { status, headers, bytes } = await entry.template;
    return new Response(bytes.byteLength === 0 ? null : bytes, { status, headers });
  }

  /** The policy of the real transport: every address the host stands for must be public (or allowed). A host nobody mapped is public. */
  #judge(url: URL, context: TransportContext): void {
    const host = (url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname).toLowerCase().replace(/\.$/, '');
    let addresses: readonly string[];
    if (isIP(host) !== 0) addresses = [host];
    else if (this.names.has(host)) addresses = this.names.get(host)!;
    else if (host === 'localhost' || host.endsWith('.localhost')) addresses = LOOPBACK;
    else return;
    if (addresses.length === 0) throw new FetchError('network', 'The host did not resolve.');
    for (const address of addresses) {
      if (!context.isPublic(address)) throw new FetchError('refused', 'The host is an address that is not public.', { cause: new Error(`${host} is ${address}`) });
    }
  }
}

/**
 * Answers outgoing requests from replies a test registers, instead of the network — `@marmeon/testing` puts it in place of the
 * `HttpClient` (`app.http`). It applies the address policy and the redirect rules of the real client, so a test of "the editor
 * entered `169.254.169.254`" passes as it would against `direct`. A request nobody answered throws a `FetchError` (`network`).
 * See `docs/http-client.md#testing`.
 */
export class HttpClientFake extends HttpClient {
  readonly #transport: FakeTransport;

  /** @internal `createTestApp()` makes it with the ranges `FETCH_ALLOWED_ADDRESSES` names; an entry that is no range is a `FetchSetupError` (S9), as at a real start. */
  constructor(allow: readonly string[] = []) {
    const transport = new FakeTransport();
    super({ transport, allow: allowedRanges(allow) });
    this.#transport = transport;
  }

  /** Answers the requests `match` matches with `reply`; a static `Response` is read once and copied for every request (see {@link FakeReply}). The latest registration that matches wins. */
  respond(match: RequestMatch, reply: FakeReply): this {
    this.#transport.replies.push({ match: normalised(match), reply });
    return this;
  }

  /** Makes `host` stand for `addresses`, as the resolver would; the policy judges them (an empty list: the host does not resolve). A host that is not mapped is public, `localhost` is loopback. */
  dns(host: string, addresses: readonly string[]): this {
    this.#transport.names.set(hostKey(host), [...addresses]);
    return this;
  }

  /** Makes the next `times` requests that pass the address policy fail with a `FetchError` of `reason`. */
  failNext(reason: FetchErrorReason = 'network', times = 1): this {
    if (!Object.hasOwn(MESSAGES, reason)) throw new TypeError(`failNext() takes a FetchError reason (${Object.keys(MESSAGES).join(', ')}), not ${JSON.stringify(reason)}.`);
    if (!Number.isInteger(times) || times < 1) throw new TypeError('failNext() takes a whole number of times, 1 or more.');
    for (let i = 0; i < times; i++) this.#transport.failures.push(reason);
    return this;
  }

  /** The requests that passed the address policy, in order, each with its body (`await request.clone().text()`). A refused request is not among them. */
  get requests(): readonly Request[] {
    return [...this.#transport.requests];
  }

  /** Throws an `AssertionError` unless a request matches. */
  assertSent(filter: RequestMatch): this {
    const match = normalised(filter);
    if (!this.#transport.requests.some((request) => matches(match, request))) {
      throw new AssertionError({ message: `Expected a request matching the filter. Sent: ${this.#transport.requests.map(describeRequest).join('; ') || 'nothing'}.` });
    }
    return this;
  }

  assertSentCount(count: number): this {
    const actual = this.#transport.requests.length;
    if (actual !== count) throw new AssertionError({ message: `Expected ${count} requests, sent ${actual}.`, actual, expected: count });
    return this;
  }

  assertNothingSent(): this {
    if (this.#transport.requests.length > 0) throw new AssertionError({ message: `Expected no request, sent ${this.#transport.requests.map(describeRequest).join('; ')}.` });
    return this;
  }
}

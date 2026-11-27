import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { withCode } from '@marmeon/core/internal';
import type { HttpClient } from '@marmeon/fetch';
import { SearchSetupError } from '../../errors.ts';

export type FetchModule = typeof import('@marmeon/fetch');

/** Resolves a host name to the addresses a connection may go to. */
export type Lookup = (host: string) => Promise<readonly string[]>;

/** Waits the given milliseconds; replaceable by a test. */
export type Sleep = (milliseconds: number) => Promise<void>;

/** The current time in milliseconds; replaceable by a test. */
export type Now = () => number;

/** Seconds one request to Meilisearch may take. */
const REQUEST_TIMEOUT = 10;
/** How long a write waits for its Meilisearch task before the attempt fails. A job past its own timeout stops in `SyncSearchDocuments` (`job.signal`). */
const TASK_DEADLINE_MS = 8_000;
const FIRST_POLL_MS = 20;
const MAX_POLL_MS = 500;
const ERROR_CODE = /^[a-z0-9_]{1,64}$/;

function setup(message: string): SearchSetupError {
  return new SearchSetupError(withCode('Q9', message));
}

/**
 * @marmeon/fetch is an optional peer: only the `meilisearch` driver needs it, so it is imported once that driver is chosen. `undefined`
 * only when the package itself is missing (the importer's path may name it, and so may another missing package's error). `load` is the
 * import, replaceable by a test.
 * @internal
 */
export async function importFetch(load: () => Promise<FetchModule> = () => import('@marmeon/fetch')): Promise<FetchModule | undefined> {
  try {
    return await load();
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND' && /Cannot find (?:package|module) '@marmeon\/fetch'/.test(String((error as Error).message))) return undefined;
    throw error;
  }
}

/**
 * `SEARCH_MEILISEARCH_URL` as the base of every request: http or https, a host, no user or password, no query or fragment, and no path
 * but `/`. Anything else stops the start (Q9); the message never repeats the value, which could hold a credential.
 * @internal
 */
export function meilisearchUrl(text: string): URL {
  if (text.trim() === '') throw setup('SEARCH_DRIVER=meilisearch needs SEARCH_MEILISEARCH_URL, the address of your Meilisearch server, such as http://127.0.0.1:7700.');
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    throw setup('SEARCH_MEILISEARCH_URL is not an address. Write it as http://host:port or https://host.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw setup('SEARCH_MEILISEARCH_URL must start with http:// or https://.');
  if (url.username !== '' || url.password !== '') throw setup('SEARCH_MEILISEARCH_URL carries a user name or a password. Put the key into SEARCH_MEILISEARCH_API_KEY instead.');
  // `?` and `#` alone leave `search` and `hash` empty, so the text is checked as well.
  if (url.search !== '' || url.hash !== '' || /[?#]/.test(text)) throw setup('SEARCH_MEILISEARCH_URL must not carry a query or a fragment.');
  if (url.pathname !== '/') throw setup('SEARCH_MEILISEARCH_URL must not carry a path: Meilisearch answers at the root of its address.');
  if (url.hostname === '') throw setup('SEARCH_MEILISEARCH_URL names no host.');
  return url;
}

/**
 * `SEARCH_MEILISEARCH_API_KEY`, trimmed: required, and printable ASCII (a master key may hold spaces; a control character would break the header). Anything else stops
 * the start (Q9); the message never repeats the value.
 * @internal
 */
export function meilisearchApiKey(text: string): string {
  const value = text.trim();
  if (value === '') throw setup('SEARCH_DRIVER=meilisearch needs SEARCH_MEILISEARCH_API_KEY, the API key the app sends to Meilisearch.');
  if (!/^[\x20-\x7e]+$/.test(value)) throw setup('SEARCH_MEILISEARCH_API_KEY must be printable ASCII, without line breaks or other control characters. Check the value you set.');
  return value;
}

/**
 * Why a request to Meilisearch did not succeed: it was not answered (`unavailable`), the key was refused (`unauthorized`), an index it
 * names does not exist (`missing-index`) or Meilisearch refused the request (`rejected`). The message names the status and
 * Meilisearch's error code, never its error text (it can quote document values), the address or the key.
 * @internal
 */
export class MeilisearchError extends Error {
  readonly kind: 'unavailable' | 'unauthorized' | 'missing-index' | 'rejected';
  readonly code: string | undefined;

  constructor(kind: MeilisearchError['kind'], message: string, code?: string) {
    super(message);
    this.name = 'MeilisearchError';
    this.kind = kind;
    this.code = code;
  }
}

/**
 * Thrown when Meilisearch accepted a write but its task failed, was canceled or did not finish in time: the job's attempt fails and is
 * tried again. Holds Meilisearch's error code, never its error text or a document.
 * @internal
 */
export class SearchSyncError extends Error {
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'SearchSyncError';
    this.code = code;
  }
}

const defaultLookup: Lookup = async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((entry) => entry.address);
const defaultSleep: Sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export interface MeilisearchClientOptions {
  /** The checked `SEARCH_MEILISEARCH_URL`. */
  readonly url: URL;
  /** The checked `SEARCH_MEILISEARCH_API_KEY`. */
  readonly apiKey: string;
  /** Resolved for every request, so a test's `HttpClientFake` is the one used. */
  readonly http: () => HttpClient;
  readonly fetch: () => FetchModule;
  readonly lookup?: Lookup | undefined;
  readonly sleep?: Sleep | undefined;
  readonly now?: Now | undefined;
}

/**
 * Sends the driver's requests to the one Meilisearch server of `SEARCH_MEILISEARCH_URL`. Its host may resolve to a private address, so
 * each request allows exactly the addresses that host resolves to at that moment, and only on a client made for that request: the
 * app's `HttpClient` and `FETCH_ALLOWED_ADDRESSES` stay as they are. Only paths the driver builds reach it, every segment encoded and
 * the origin checked before the request; a redirect is refused, so neither the key nor the exception follows one.
 * @internal
 */
export class MeilisearchClient {
  readonly #base: URL;
  readonly #apiKey: string;
  readonly #http: () => HttpClient;
  readonly #fetch: () => FetchModule;
  readonly #lookup: Lookup;
  readonly #sleep: Sleep;
  readonly #now: Now;

  constructor(options: MeilisearchClientOptions) {
    this.#base = new URL(options.url.href);
    this.#apiKey = options.apiKey;
    this.#http = options.http;
    this.#fetch = options.fetch;
    this.#lookup = options.lookup ?? defaultLookup;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#now = options.now ?? (() => performance.now());
  }

  /** The address of a path of segments, each encoded, with the query; anything but the base's origin is refused. */
  url(segments: readonly string[], query: Readonly<Record<string, string>> = {}): URL {
    // encodeURIComponent keeps `.` and `..`, which the URL parser would resolve into another path.
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) throw new MeilisearchError('rejected', 'A Meilisearch request path had an empty, `.` or `..` segment and was not sent.');
    const url = new URL(`/${segments.map((segment) => encodeURIComponent(segment)).join('/')}`, this.#base);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    // The exception for private addresses holds for the configured server only, so no request leaves for another origin.
    if (url.origin !== this.#base.origin) throw new MeilisearchError('rejected', 'A Meilisearch request was built for another origin than SEARCH_MEILISEARCH_URL and was not sent.');
    return url;
  }

  /** The ranges the request may reach: the addresses the configured host resolves to now, each as a single address. */
  async #ranges(url: URL): Promise<string[]> {
    const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
    let addresses: readonly string[];
    if (isIP(host) !== 0) addresses = [host];
    else {
      try {
        addresses = await this.#lookup(host);
      } catch {
        throw new MeilisearchError('unavailable', 'The host of SEARCH_MEILISEARCH_URL did not resolve.');
      }
    }
    if (addresses.length === 0) throw new MeilisearchError('unavailable', 'The host of SEARCH_MEILISEARCH_URL did not resolve.');
    return addresses.map((address) => {
      // A zone index (`fe80::1%en0`) or anything that is no address cannot be a range: the request fails rather than allow more.
      const family = typeof address === 'string' && !address.includes('%') ? isIP(address) : 0;
      if (family === 0) throw new MeilisearchError('unavailable', 'The host of SEARCH_MEILISEARCH_URL resolved to an entry that is no plain IP address.');
      return family === 6 ? `${address}/128` : `${address}/32`;
    });
  }

  /**
   * Sends one request and returns the answer's parsed JSON (`undefined` for a body that is no JSON). Throws a `MeilisearchError` when
   * the request fails, is redirected or is answered with an error status.
   */
  async request(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', segments: readonly string[], options: { readonly query?: Readonly<Record<string, string>>; readonly json?: unknown } = {}): Promise<unknown> {
    const url = this.url(segments, options.query);
    const module = this.#fetch();
    const client = this.#http().allowing(await this.#ranges(url));
    let response: Response;
    try {
      response = await client.fetch(url, {
        method,
        redirect: 'error',
        timeout: REQUEST_TIMEOUT,
        headers: { accept: 'application/json', authorization: `Bearer ${this.#apiKey}` },
        ...(options.json === undefined ? {} : { json: options.json }),
      });
    } catch (error) {
      // An address the transport resolves anew that is not among those allowed here is judged by the normal policy and refused.
      if (error instanceof module.FetchError) {
        const reason =
          error.reason === 'redirects' ? 'was answered with a redirect, which is not followed' : error.reason === 'refused' ? 'was refused by the HTTP client' : error.reason === 'timeout' ? 'timed out' : 'failed';
        throw new MeilisearchError('unavailable', `The request to Meilisearch ${reason}.`);
      }
      throw error;
    }
    let body: unknown;
    try {
      body = JSON.parse(await response.text());
    } catch {
      body = undefined;
    }
    if (response.status >= 200 && response.status < 300) return body;
    const given = isRecord(body) ? body['code'] : undefined;
    const code = typeof given === 'string' && ERROR_CODE.test(given) ? given : undefined;
    const message = `Meilisearch answered ${response.status}${code === undefined ? '' : ` (${code})`}.`;
    if (code === 'index_not_found') throw new MeilisearchError('missing-index', message, code);
    if (response.status === 401 || response.status === 403) throw new MeilisearchError('unauthorized', message, code);
    if (response.status === 408 || response.status === 429 || response.status >= 500) throw new MeilisearchError('unavailable', message, code);
    throw new MeilisearchError('rejected', message, code);
  }

  /**
   * Waits until the task an answer names has succeeded. A task that failed or was canceled, or that does not finish within 8 seconds,
   * throws a `SearchSyncError`: a write never counts as done while Meilisearch may still reject it.
   */
  async waitForTask(answer: unknown): Promise<void> {
    const uid = isRecord(answer) ? answer['taskUid'] : undefined;
    if (typeof uid !== 'number' || !Number.isSafeInteger(uid) || uid < 0) throw new SearchSyncError('Meilisearch accepted a write but named no task to wait for.');
    const end = this.#now() + TASK_DEADLINE_MS;
    for (let delay = FIRST_POLL_MS; ; delay = Math.min(delay * 2, MAX_POLL_MS)) {
      const task = await this.request('GET', ['tasks', String(uid)]);
      const status = isRecord(task) ? task['status'] : undefined;
      if (status === 'succeeded') return;
      if (status === 'failed' || status === 'canceled') {
        const error = isRecord(task) && isRecord(task['error']) ? task['error']['code'] : undefined;
        const code = typeof error === 'string' && ERROR_CODE.test(error) ? error : undefined;
        throw new SearchSyncError(`The Meilisearch task ${uid} ${status === 'failed' ? 'failed' : 'was canceled'}${code === undefined ? '' : ` (${code})`}.`, code);
      }
      if (status !== 'enqueued' && status !== 'processing') throw new SearchSyncError(`The Meilisearch task ${uid} has a status this driver does not know.`);
      if (this.#now() >= end) throw new SearchSyncError(`The Meilisearch task ${uid} did not finish within ${TASK_DEADLINE_MS / 1000} seconds.`);
      await this.#sleep(delay);
    }
  }
}

import { CookieJar } from './cookies.ts';
import { HttpError } from './errors.ts';

/**
 * Request input: the body, nested by bracket notation (`user[name]`, `tags[]`). Never the query (E65): a field of the
 * body cannot be set through the URL — a link, a log line or a `Referer` must not be able to fill in a form.
 */
export type Input = Record<string, unknown>;

export interface RequestStateOptions {
  /** Largest accepted body in bytes. Defaults to 8 MiB (PHP's `post_max_size`). */
  maxBodySize?: number;
  /** The client's IP address, as the server determined it (see the kernel's trusted proxies). */
  ip?: string | undefined;
}

/**
 * What the router adds to every request context beyond the raw `Request`:
 * the query, the parsed input, cookies and content negotiation.
 */
export interface RequestState {
  /**
   * The query string, `ctx.query.get('page')` — or, behind a request with a `query` schema, the parsed query
   * (`defineRequest({ query })`).
   */
  readonly query: URLSearchParams;
  /**
   * The body — and only the body (E65): unlike Laravel's `$request->all()`, the query is never merged in, so no
   * field can be set through the URL (read it from `ctx.query`). A GET or HEAD request has no body: `{}`.
   * JSON, `application/x-www-form-urlencoded` and `multipart/form-data` (files are
   * `File`s) are parsed alike. Parsed once and cached: a request body can only be
   * read once, so don't read `ctx.request` yourself after calling this.
   */
  input(): Promise<Input>;
  /**
   * The body if something read it already (`input()` resolved), else undefined — never reads it itself. For observers
   * (the devtools record what the app read, E118), which must not consume or wait for a body.
   */
  readonly inputRead?: () => Input | undefined;
  readonly cookies: CookieJar;
  /** The client's IP address — behind trusted proxies taken from `X-Forwarded-For`. Undefined in tests. */
  readonly ip: string | undefined;
  /** The client wants JSON back (an API call), not a page. */
  expectsJson(): boolean;
}

export const DEFAULT_MAX_BODY_SIZE = 8 * 1024 * 1024;

/** Bracket nesting deeper than this is rejected (a request is not a data structure attack surface). */
const MAX_DEPTH = 20;

export function createRequestState(request: Request, { maxBodySize = DEFAULT_MAX_BODY_SIZE, ip }: RequestStateOptions = {}): RequestState {
  const query = new URL(request.url).searchParams;
  let input: Promise<Input> | undefined;
  let read: Input | undefined;

  return {
    query,
    input: () =>
      (input ??= parseInput(request, maxBodySize).then((parsed) => {
        read = parsed;
        return parsed;
      })),
    inputRead: () => read,
    cookies: new CookieJar(request.headers.get('cookie')),
    ip,
    expectsJson: () => expectsJson(request),
  };
}

/**
 * The client's address behind proxies: the right-most `X-Forwarded-For` entry that
 * is not a trusted proxy. Left entries are whatever the client claimed, so they
 * count only once every hop to their right is trusted. `'*'` trusts every hop
 * (a platform that always sits behind its own load balancer).
 */
export function clientIp(remote: string | undefined, forwardedFor: string | null, trusted: readonly string[]): string | undefined {
  const normalize = (address: string) => address.trim().replace(/^::ffff:/, '');
  if (remote === undefined) return undefined;
  const isTrusted = (address: string) => trusted.includes('*') || trusted.includes(normalize(address));
  if (!isTrusted(remote) || !forwardedFor) return normalize(remote);
  const chain = forwardedFor.split(',').map(normalize).filter(Boolean);
  for (let i = chain.length - 1; i >= 0; i--) {
    if (!isTrusted(chain[i]!) || i === 0) return chain[i];
  }
  return normalize(remote);
}

/** Laravel's `expectsJson()`: JSON is the first accepted type, or an XHR that accepts anything. */
export function expectsJson(request: Request): boolean {
  const accept = request.headers.get('accept') ?? '';
  const first = accept.split(',')[0]!.split(';')[0]!.trim().toLowerCase();
  if (/[/+]json$/.test(first)) return true;
  return request.headers.get('x-requested-with') === 'XMLHttpRequest' && (first === '' || first === '*/*');
}

async function parseInput(request: Request, maxBodySize: number): Promise<Input> {
  const type = mediaType(request);
  if (request.method === 'GET' || request.method === 'HEAD' || request.body === null || type === undefined) {
    return build([]);
  }

  if (type === 'application/json' || type.endsWith('+json')) {
    const text = new TextDecoder().decode(await readBody(request, maxBodySize));
    if (text.trim() === '') return build([]);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new HttpError(400, 'Malformed JSON body.');
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new HttpError(400, 'The JSON body must be an object.');
    }
    return { ...body };
  }

  if (type === 'application/x-www-form-urlencoded') {
    const form = new URLSearchParams(new TextDecoder().decode(await readBody(request, maxBodySize)));
    return build(form);
  }

  if (type === 'multipart/form-data') {
    const bytes = await readBody(request, maxBodySize);
    let form: FormData;
    try {
      form = await new Response(bytes, { headers: { 'content-type': request.headers.get('content-type')! } }).formData();
    } catch {
      throw new HttpError(400, 'Malformed multipart body.');
    }
    return build(form);
  }

  // Other bodies (text/plain, binary uploads) are not input; read them from `ctx.request`.
  return build([]);
}

function mediaType(request: Request): string | undefined {
  return request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() || undefined;
}

/** Reads the body up to `limit` bytes — a lying or missing `Content-Length` changes nothing. */
async function readBody(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const tooLarge = () => new HttpError(413, `The request body exceeds ${limit} bytes.`);
  const declared = Number(request.headers.get('content-length'));
  if (declared > limit) throw tooLarge();

  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body!.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

// ---------------------------------------------------------------------------
// Bracket notation: `user[name]=Ada&tags[]=a&tags[]=b` → { user: { name: 'Ada' }, tags: ['a', 'b'] }
// ---------------------------------------------------------------------------

type Node = { [key: string]: Node | string | File };

const KEY = /^([^[\]]+)((?:\[[^[\]]*\])*)$/;

/**
 * Builds nested input from form entries, like PHP. Later entries win, an empty
 * file field (no file chosen) is skipped, and objects whose keys are exactly
 * `0…n-1` become arrays — so sparse indices can never allocate huge arrays.
 */
function build(entries: Iterable<[string, string | File]>): Input {
  const root: Node = Object.create(null);
  for (const [key, value] of entries) {
    if (typeof value !== 'string' && value.name === '' && value.size === 0) continue;
    assign(root, segments(key), value);
  }
  return finalize(root) as Input;
}

function segments(key: string): string[] {
  const match = KEY.exec(key);
  if (!match) return [key];
  const nested = [...match[2]!.matchAll(/\[([^[\]]*)\]/g)].map((m) => m[1]!);
  if (nested.length > MAX_DEPTH) throw new HttpError(400, `Input "${match[1]}" is nested too deeply.`);
  return [match[1]!, ...nested];
}

function assign(root: Node, path: string[], value: string | File): void {
  let node = root;
  for (let i = 0; i < path.length; i++) {
    const key = path[i] === '' ? String(nextIndex(node)) : path[i]!;
    if (key === '__proto__') return;
    if (i === path.length - 1) {
      node[key] = value;
      return;
    }
    const child = node[key];
    node = node[key] = typeof child === 'object' && !(child instanceof File) ? child : Object.create(null);
  }
}

function nextIndex(node: Node): number {
  let next = 0;
  for (const key of Object.keys(node)) if (/^\d+$/.test(key)) next = Math.max(next, Number(key) + 1);
  return next;
}

function finalize(node: Node | string | File): unknown {
  if (typeof node === 'string' || node instanceof File) return node;
  const keys = Object.keys(node);
  if (keys.length > 0 && keys.every((key, index) => key === String(index))) return keys.map((key) => finalize(node[key]!));
  const result: Record<string, unknown> = {};
  for (const key of keys) result[key] = finalize(node[key]!);
  return result;
}

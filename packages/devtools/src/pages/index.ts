import { EnvironmentConfig, outsideTransaction, type Application, type Redactor } from '@marmeon/core';
import { devOnly } from '@marmeon/core/dev';
import type { EmptyObject, HttpContext, Next } from '@marmeon/router';
import { ENTRY_TYPES, type AnyEntry, type EntryType } from '../entry.ts';
import { matchesEntry, MAX_LIMIT, type DevtoolsStore, type EntryQuery } from '../store.ts';
import { MAIL_CSP } from './assets.ts';
import { queueSnapshot, scheduleSnapshot } from './infra.ts';
import { BASE, entryHref, SLUGS } from './layout.ts';
import { row } from './rows.ts';
import { htmlResponse, jsonResponse } from './security.ts';
import { findController, findView } from './source.ts';
import { batchPage, entryPage, listPage, listQuery, overviewPage, queuePage, schedulePage, type Frame, type ListFilters } from './views.ts';

export { BASE } from './layout.ts';
export { MAIL_CSP, PAGE_CSP } from './assets.ts';

/** The version of the JSON API and the stream (documented: the in-page bar builds on it). */
export const API_VERSION = 1;

/** Entries per page of a list. */
const PAGE_SIZE = 50;
/** How often the stream asks the store for new entries — a worker's job shows in well under a second. */
const POLL_MS = 250;
const HEARTBEAT_MS = 15_000;

export interface PagesOptions {
  readonly app: Application;
  readonly store: DevtoolsStore;
  readonly redactor: Redactor;
  /** The hosts the pages answer (DNS rebinding): loopback names and `APP_URL`'s. */
  readonly hosts: ReadonlySet<string>;
  /** The ring's size, for the overview. */
  readonly maxBytes?: number;
}

/**
 * Registers `/_marmeon/devtools` — called only where the devtools run (`NODE_ENV=development` or a test's opt-in). Every
 * route is GET only, outside every middleware group (no session, cookies or CSRF), behind the host check of development
 * routes (DNS rebinding), `no-store`, with a strict CSP and no CORS header. See docs/devtools.md#how-the-pages-are-protected.
 */
export async function registerDevtoolsPages(options: PagesOptions): Promise<boolean> {
  let router: typeof import('@marmeon/router');
  try {
    router = await import('@marmeon/router');
  } catch {
    return false; // no HTTP in this app
  }
  const { app } = options;
  if (!app.container.has(router.Router)) return false;
  // A stream ends when the server closes (`ServerClosing` of @marmeon/http — every app with routes has it).
  const http = await import('@marmeon/http').catch(() => undefined);
  const closing = () => (http && app.container.has(http.ServerClosing) ? app.container.make(http.ServerClosing).signal : undefined);
  const pages = new DevtoolsPages(options, () => app.container.make(router.Router).routes.some((route) => route.path === '/_marmeon/mail'), closing);
  // The guard of every development route (`@marmeon/core/dev`): 403 for another host, the dev headers on every answer.
  const guard = router.defineMiddleware('DevtoolsGuard', devOnly(options.hosts, (_ctx: HttpContext, next: Next<EmptyObject>) => next()));

  app.container.make(router.Router).load(
    // No group: no session, no cookies. The guard runs for every route here.
    { framework: router.FRAMEWORK_ROUTES },
    router.defineRoutes((Route) => {
      Route.middleware(guard)
        .prefix(BASE)
        .group((Route) => {
          Route.get('/', () => pages.overview());
          for (const type of ENTRY_TYPES) {
            Route.get(`/${SLUGS[type]}`, (ctx) => pages.list(type, new URL(ctx.request.url)));
            Route.get(`/${SLUGS[type]}/:id`, (ctx) => pages.entry(type, ctx.params.id));
          }
          Route.get('/mails/:id/html', (ctx) => pages.mailHtml(ctx.params.id));
          Route.get('/batches/:batch', (ctx) => pages.batch(ctx.params.batch));
          Route.get('/queue', () => pages.queue());
          Route.get('/stream', (ctx) => pages.stream(ctx.request));
          Route.get('/api', () => pages.apiIndex());
          Route.get('/api/status', () => pages.apiStatus());
          Route.get('/api/entries', (ctx) => pages.apiEntries(new URL(ctx.request.url)));
          Route.get('/api/entries/:id', (ctx) => pages.apiEntry(ctx.params.id));
          Route.get('/api/requests/:requestId', (ctx) => pages.apiRequest(ctx.params.requestId));
          Route.get('/api/batches/:batch', (ctx) => pages.apiBatch(ctx.params.batch));
          Route.get('/api/queue', () => pages.apiQueue());
          Route.get('/api/schedule', () => pages.apiSchedule());
          Route.get('/api/source', (ctx) => pages.apiSource(new URL(ctx.request.url)));
        });
    }),
  );
  return true;
}

/** The query string's filters of a list. */
function filtersOf(url: URL): ListFilters {
  const value = (key: string) => {
    const found = url.searchParams.get(key)?.trim();
    return found ? found.slice(0, 500) : undefined;
  };
  const filters: Record<string, string> = {};
  for (const key of ['search', 'tag', 'status', 'route', 'requestId', 'jobId', 'batch', 'before'] as const) {
    const found = value(key);
    if (found !== undefined) filters[key] = found;
  }
  return filters;
}

/** An API query from a query string — `type` and `tag` may repeat. Undefined for an unknown type. */
function apiQuery(url: URL): EntryQuery | undefined {
  const params = url.searchParams;
  const types = params.getAll('type').flatMap((type) => type.split(','));
  if (types.some((type) => !ENTRY_TYPES.includes(type as EntryType))) return undefined;
  const tags = params.getAll('tag').filter(Boolean);
  const limit = Number(params.get('limit') ?? PAGE_SIZE);
  return {
    ...(types.length > 0 ? { type: types as EntryType[] } : {}),
    ...(tags.length > 0 ? { tag: tags } : {}),
    ...Object.fromEntries((['batch', 'requestId', 'jobId', 'search', 'before'] as const).flatMap((key) => (params.get(key) ? [[key, params.get(key)!.slice(0, 500)]] : []))),
    limit: Number.isFinite(limit) ? Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit))) : PAGE_SIZE,
  };
}

const oldestFirst = (entries: readonly AnyEntry[]) => [...entries].reverse();

const notFound = (what: string) => htmlResponse(`<!doctype html><title>Not found</title><p>${what}</p><p><a href="${BASE}">Devtools</a></p>`, 404);

class DevtoolsPages {
  readonly #store: DevtoolsStore;
  readonly #app: Application;
  readonly #redactor: Redactor;
  readonly #maxBytes: number | undefined;
  readonly #mailPreviews: () => boolean;
  /** The server's closing signal: a stream ends when the server closes. */
  readonly #closing: () => AbortSignal | undefined;

  constructor(options: PagesOptions, mailPreviews: () => boolean, closing: () => AbortSignal | undefined) {
    this.#store = options.store;
    this.#app = options.app;
    this.#redactor = options.redactor;
    this.#maxBytes = options.maxBytes;
    this.#mailPreviews = mailPreviews;
    this.#closing = closing;
  }

  /** The app's `APP_ENV` for the header — informative, as everywhere. */
  #environment(): { environment?: string } {
    return this.#app.container.has(EnvironmentConfig) ? { environment: this.#app.container.make(EnvironmentConfig).app } : {};
  }

  async #frame(): Promise<Frame> {
    const usage = await this.#store.usage();
    return { usage, mailPreviews: this.#mailPreviews(), ...this.#environment() };
  }

  async overview(): Promise<Response> {
    const [requests, exceptions, slowQueries, failedJobs, queue, schedule, usage] = await Promise.all([
      this.#store.list({ type: 'request', limit: 12 }),
      this.#store.list({ type: 'exception', limit: 8 }),
      this.#store.list({ type: 'query', tag: 'slow', limit: 8 }),
      this.#store.list({ type: 'job', tag: 'failed', limit: 8 }),
      queueSnapshot(this.#app, this.#redactor),
      scheduleSnapshot(this.#app),
      this.#store.usage(),
    ]);
    const warnings = [
      ...(schedule.available && schedule.warning ? [`Scheduler: ${schedule.warning}`] : []),
      ...this.#app.container.warnings.map((warning) => `Injection: ${warning.message}`),
      ...(this.#maxBytes && usage.bytes > this.#maxBytes * 0.8 ? [`The devtools' files hold ${Math.round((usage.bytes / this.#maxBytes) * 100)} % of their limit — the oldest go first (marmeon devtools:clear empties them).`] : []),
    ];
    return htmlResponse(
      overviewPage(
        { usage, mailPreviews: this.#mailPreviews(), ...this.#environment() },
        { requests, exceptions, slowQueries, failedJobs, queue, schedule, warnings, usage, ...(this.#maxBytes ? { maxBytes: this.#maxBytes } : {}) },
      ),
    );
  }

  async list(type: EntryType, url: URL): Promise<Response> {
    const filters = filtersOf(url);
    const entries = await this.#store.list(listQuery(type, filters, PAGE_SIZE));
    const frame = await this.#frame();
    if (type === 'schedule') return htmlResponse(schedulePage(frame, await scheduleSnapshot(this.#app), entries, filters, PAGE_SIZE));
    return htmlResponse(listPage(frame, type, entries, filters, PAGE_SIZE));
  }

  async entry(type: EntryType, id: string): Promise<Response> {
    let entry = await this.#store.get(id);
    if (!entry && type === 'request') {
      // A request id (`x-request-id`) instead of an entry's: its outer request.
      const found = (await this.#store.list({ type: 'request', requestId: id, limit: 20 })).filter((candidate) => candidate.type === 'request');
      const outer = found.find((candidate) => candidate.type === 'request' && !candidate.content.inProcess) ?? found[0];
      if (outer) return new Response(null, { status: 302, headers: { location: entryHref(outer) } });
    }
    if (!entry || entry.type !== type) return notFound(`No ${type} entry ${id} — the ring keeps entries for 24 hours.`);
    const batch = oldestFirst(await this.#store.list({ batch: entry.batch, limit: MAX_LIMIT }));
    const triggered = entry.type === 'request' && entry.requestId ? oldestFirst((await this.#store.list({ requestId: entry.requestId, limit: MAX_LIMIT })).filter((candidate) => candidate.batch !== entry!.batch)) : [];
    return htmlResponse(entryPage(await this.#frame(), entry, { batch, triggered }));
  }

  async batch(batch: string): Promise<Response> {
    return htmlResponse(batchPage(await this.#frame(), batch, oldestFirst(await this.#store.list({ batch, limit: MAX_LIMIT }))));
  }

  /** A recorded mail's HTML, for the frame on its page: `sandbox` without scripts by CSP too (opened in a tab of its own). */
  async mailHtml(id: string): Promise<Response> {
    const entry = await this.#store.get(id);
    if (!entry || entry.type !== 'mail' || entry.content.html === undefined) return new Response('No such mail.', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    return new Response(entry.content.html, { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': MAIL_CSP } });
  }

  async queue(): Promise<Response> {
    const [queue, attempts] = await Promise.all([queueSnapshot(this.#app, this.#redactor), this.#store.list({ type: 'job', limit: 20 })]);
    return htmlResponse(queuePage(await this.#frame(), queue, attempts));
  }

  /**
   * `GET /_marmeon/devtools/stream` — Server-Sent Events: each new entry of any process (the server, the worker, the scheduler)
   * as `event: entry` with `data: {"entry": …}` (and, with `rows=1`, the list row the pages insert), narrowed by `type`, `tag`
   * (both may repeat), `requestId`, `jobId`, `batch`, `search`. It starts with what arrives from now on.
   */
  stream(request: Request): Response {
    const url = new URL(request.url);
    const query = apiQuery(url);
    if (!query) return jsonResponse({ error: 'unknown type', types: ENTRY_TYPES }, 400);
    const rows = url.searchParams.get('rows') === '1';
    const closing = this.#closing();
    const encoder = new TextEncoder();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let open = true;
    const stop = () => {
      open = false;
      clearTimeout(timer);
      clearInterval(heartbeat);
    };
    const store = this.#store;
    const readable = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const write = (text: string) => {
          if (!open) return;
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            stop();
          }
        };
        const end = () => {
          if (!open) return;
          stop();
          try {
            controller.close();
          } catch {
            // Already closed by the reader.
          }
        };
        request.signal.addEventListener('abort', end, { once: true });
        closing?.addEventListener('abort', end, { once: true });
        let { cursor } = await outsideTransaction(() => store.since());
        write(`retry: 2000\n\nevent: ready\ndata: ${JSON.stringify({ version: API_VERSION })}\n\n`);
        heartbeat = setInterval(() => write(': heartbeat\n\n'), HEARTBEAT_MS);
        heartbeat.unref?.();
        const poll = async () => {
          if (!open) return;
          try {
            const tail = await outsideTransaction(() => store.since(cursor));
            cursor = tail.cursor;
            for (const entry of tail.entries) {
              if (!matchesEntry(entry, query)) continue;
              write(`event: entry\ndata: ${JSON.stringify(rows ? { entry, row: row(entry).toString() } : { entry })}\n\n`);
            }
          } catch {
            // A read that failed (a file pruned under it): the next poll tries again.
          }
          if (open) timer = setTimeout(() => void poll(), POLL_MS);
        };
        timer = setTimeout(() => void poll(), POLL_MS);
        if (request.signal.aborted || closing?.aborted) end();
      },
      cancel: () => stop(),
    });
    return new Response(readable, {
      headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-store, no-transform', 'x-accel-buffering': 'no' },
    });
  }

  apiIndex(): Response {
    return jsonResponse({
      version: API_VERSION,
      types: ENTRY_TYPES,
      endpoints: {
        status: `${BASE}/api/status`,
        entries: `${BASE}/api/entries?type=&tag=&requestId=&jobId=&batch=&search=&before=&limit=`,
        entry: `${BASE}/api/entries/:id`,
        request: `${BASE}/api/requests/:requestId`,
        batch: `${BASE}/api/batches/:batch`,
        queue: `${BASE}/api/queue`,
        schedule: `${BASE}/api/schedule`,
        source: `${BASE}/api/source?controller=|view=`,
        stream: `${BASE}/stream?type=&tag=&requestId=&jobId=&batch=&search=`,
      },
    });
  }

  async apiStatus(): Promise<Response> {
    return jsonResponse({ version: API_VERSION, usage: await this.#store.usage(), ...(this.#maxBytes ? { maxBytes: this.#maxBytes } : {}), types: ENTRY_TYPES });
  }

  async apiEntries(url: URL): Promise<Response> {
    const query = apiQuery(url);
    if (!query) return jsonResponse({ error: 'unknown type', types: ENTRY_TYPES }, 400);
    const entries = await this.#store.list(query);
    return jsonResponse({ entries, next: entries.length === query.limit ? (entries.at(-1)?.id ?? null) : null });
  }

  async apiEntry(id: string): Promise<Response> {
    const entry = await this.#store.get(id);
    return entry ? jsonResponse({ entry }) : jsonResponse({ error: 'not found' }, 404);
  }

  /** Everything of one request: its own batch and what its jobs recorded in a worker — oldest first. */
  async apiRequest(requestId: string): Promise<Response> {
    const entries = oldestFirst(await this.#store.list({ requestId, limit: MAX_LIMIT }));
    return jsonResponse({ requestId, entries, batches: [...new Set(entries.map((entry) => entry.batch))] });
  }

  async apiBatch(batch: string): Promise<Response> {
    return jsonResponse({ batch, entries: oldestFirst(await this.#store.list({ batch, limit: MAX_LIMIT })) });
  }

  async apiQueue(): Promise<Response> {
    return jsonResponse(await queueSnapshot(this.#app, this.#redactor));
  }

  /** Where a controller (`?controller=ShowUserController`) or a view (`?view=users/Show`) is — for "open in editor". */
  async apiSource(url: URL): Promise<Response> {
    const controller = url.searchParams.get('controller');
    const view = url.searchParams.get('view');
    const found = controller ? await findController(this.#app.root, controller) : view ? findView(this.#app.root, view) : undefined;
    return found ? jsonResponse(found) : jsonResponse({ error: 'not found' }, 404);
  }

  async apiSchedule(): Promise<Response> {
    const [schedule, runs] = await Promise.all([scheduleSnapshot(this.#app), this.#store.list({ type: 'schedule', limit: 20 })]);
    return jsonResponse({ ...schedule, runs });
  }
}

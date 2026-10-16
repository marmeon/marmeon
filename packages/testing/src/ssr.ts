import type { DeferredResult, PageObject, RegionResult } from '@marmeon/http/page';
import type { ApplicationDefinition } from '@marmeon/core';
import type { PageRenderer } from '@marmeon/server';
import { createViteDevRenderer } from '@marmeon/server/internal';

/** Marks a test request, so the SSR errors of exactly that request reach its response. */
export const SSR_TEST_HEADER = 'x-marmeon-test-render';

/** What server rendering did for one response (`createTestApp(…, { ssr: true })`). */
export interface SsrOutcome {
  /** Errors while rendering — in the shell (the page went out without markup) or after it. */
  readonly errors: readonly unknown[];
  /** The document rendered again from the page object as the browser reads it: what hydration compares against. */
  readonly rerendered: string | undefined;
  /**
   * Streamed (`ssr: 'stream'`): the server's document as it stands once every part has streamed in — what the browser
   * hydrates. The response itself is the shell plus the late parts with their scripts, never equal to a complete render.
   */
  readonly rendered?: string | undefined;
}

/**
 * One Vite dev server for a test file's server-rendered apps, started with {@link startSsrServer}: pass it as
 * `createTestApp(…, { ssr: true, ssrServer })`. See docs/testing-pages.md#one-vite-server-per-file.
 */
export interface SsrServer {
  /** The app's root directory the server was started for. */
  readonly root: string;
  /** Stops the server — in `afterAll`. Test apps still using it can no longer render. */
  close(): Promise<void>;
}

interface SsrServerState {
  readonly root: string;
  readonly renderer: PageRenderer;
  closed: boolean;
}

/** The renderer behind each {@link SsrServer}, kept out of the public shape. */
const servers = new WeakMap<SsrServer, SsrServerState>();

/**
 * Starts one Vite dev server (through the app's `vite.config.ts`, as `marmeon dev` does) that every server-rendered test app
 * of a file can share: start it in `beforeAll`, close it in `afterAll`. See docs/testing-pages.md#one-vite-server-per-file.
 */
export async function startSsrServer(application: ApplicationDefinition): Promise<SsrServer> {
  const { vite, renderer } = await createViteDevRenderer({ root: application.root });
  const state: SsrServerState = { root: application.root, renderer, closed: false };
  let closing: Promise<void> | undefined;
  const server: SsrServer = Object.freeze({
    root: application.root,
    close: () => {
      state.closed = true;
      return (closing ??= vite.close());
    },
  });
  servers.set(server, state);
  return server;
}

/** Throws unless `server` is a running server made for the app at `root` — checked before a test app boots, and again when it renders. */
export function checkSsrServer(server: SsrServer, root: string): void {
  usable(server, root);
}

function usable(server: SsrServer, root: string): SsrServerState {
  const state = servers.get(server);
  if (!state) throw new Error('createTestApp(…, { ssrServer }): not a server made by startSsrServer().');
  if (state.closed) throw new Error('The SSR server was closed — start it in beforeAll and close it in afterAll.');
  if (state.root !== root) throw new Error(`createTestApp(…, { ssrServer }): the server was started for ${state.root}, the app's root is ${root}.`);
  return state;
}

/** What one render resolved while it streamed — the browser renders the same again from it, never asking again. */
interface Resolved {
  readonly islands: Map<string, RegionResult>;
  readonly deferred: Map<string, DeferredResult | null>;
  /** Streamed: the page as the server rendered it (its live props) — rendered once more, completely, for the comparison. */
  page?: PageObject;
  /** The response's CSP nonce, when it had one. */
  nonce?: string;
}

/**
 * Server rendering for tests, through the app's Vite setup (as `marmeon dev` renders): `<Head>` and markup become
 * testable. Every page is rendered completely — like for a bot — so the markup does not depend on timing; with
 * `stream`, as for a browser (the shell first, the rest as it is ready).
 */
export class TestSsr {
  readonly renderer: PageRenderer;
  readonly #close: () => Promise<void>;
  readonly #errors = new Map<string, unknown[]>();
  /** What each render's islands and deferred groups resolved to — the browser renders them again from that, not from a request. */
  readonly #resolved = new Map<string, Resolved>();
  readonly #stream: boolean;
  #next = 0;

  private constructor(renderer: PageRenderer, close: () => Promise<void>, { stream = false }: { stream?: boolean } = {}) {
    this.#close = close;
    this.#stream = stream;
    const record = (request: Request, error: unknown) => {
      const id = request.headers.get(SSR_TEST_HEADER);
      if (id) this.#errors.get(id)?.push(error);
    };
    const resolved = this.#resolved;
    this.renderer = {
      ...renderer,
      async render(page, request, options) {
        const id = request.headers.get(SSR_TEST_HEADER);
        const { resolveIsland, resolveDeferred } = options;
        const seen = id ? resolved.get(id) : undefined;
        if (seen && stream) seen.page = page;
        // The response's CSP nonce: the browser reads the same document — rendered again with it.
        if (seen && options.nonce) seen.nonce = options.nonce;
        try {
          const document = await renderer.render(page, request, {
            ...options,
            complete: stream ? options.complete : true,
            onError: (error) => {
              record(request, error);
              options.onError(error);
            },
            ...(resolveIsland
              ? {
                  resolveIsland: async (url: string) => {
                    const result = await resolveIsland(url);
                    seen?.islands.set(url, result);
                    return result;
                  },
                }
              : {}),
            ...(resolveDeferred
              ? {
                  resolveDeferred: async (group: string) => {
                    const result = await resolveDeferred(group);
                    seen?.deferred.set(group, result);
                    return result;
                  },
                }
              : {}),
          });
          return typeof document === 'string' || stream ? document : await new Response(document).text();
        } catch (error) {
          record(request, error);
          throw error;
        }
      },
      shell: (page, request, nonce) => renderer.shell(page, request, nonce),
    };
  }

  static async start(root: string, options: { stream?: boolean; server?: SsrServer } = {}): Promise<TestSsr> {
    const { server } = options;
    if (server) {
      const state = usable(server, root);
      // The shared Vite outlives this app: closing the app only drops its own error and island bookkeeping.
      return new TestSsr(state.renderer, async () => {}, options);
    }
    const { vite, renderer } = await createViteDevRenderer({ root });
    return new TestSsr(renderer, () => vite.close(), options);
  }

  /** A fresh id for the next request — send it as {@link SSR_TEST_HEADER}. */
  begin(): string {
    const id = String(this.#next++);
    this.#errors.set(id, []);
    this.#resolved.set(id, { islands: new Map(), deferred: new Map() });
    return id;
  }

  /** What happened while rendering request `id`, and the page rendered again from its JSON (the browser's view of it). */
  async finish(id: string, url: string, page: PageObject | undefined): Promise<SsrOutcome> {
    const errors = this.#errors.get(id) ?? [];
    const { islands, deferred, page: live, nonce } = this.#resolved.get(id) ?? { islands: new Map<string, RegionResult>(), deferred: new Map<string, DeferredResult | null>() };
    this.#errors.delete(id);
    this.#resolved.delete(id);
    if (!page || errors.length > 0) return { errors, rerendered: undefined };
    const noop = () => {};
    // The browser's view: its islands and deferred groups as the server streamed them — never asked for again.
    const options = {
      // Streamed: both the same way — the late parts come from what was recorded, so only the props can differ.
      complete: !this.#stream,
      onError: noop,
      onWarning: noop,
      resolveIsland: async (island: string): Promise<RegionResult> => islands.get(island) ?? { status: 'browser' },
      ...(this.#stream ? { resolveDeferred: async (group: string): Promise<DeferredResult | null> => deferred.get(group) ?? null } : {}),
      ...(nonce ? { nonce } : {}),
    };
    const render = async (from: PageObject): Promise<string | undefined> => {
      const document = await this.renderer.render(from, new Request(url), options).catch(() => undefined);
      return document === undefined || typeof document === 'string' ? document : new Response(document).text();
    };
    const rerendered = await render(JSON.parse(JSON.stringify(page)) as PageObject);
    // Streamed, the response's timing decided what came late: compare the server's page rendered once more, from the same parts.
    if (!this.#stream) return { errors, rerendered };
    return { errors, rerendered, rendered: live ? await render(live) : undefined };
  }

  close(): Promise<void> {
    return this.#close();
  }
}

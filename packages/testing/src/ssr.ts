import type { PageObject, RegionResult } from '@bespokecore/http/page';
import { createViteDevRenderer, type PageRenderer } from '@bespokecore/server';

/** Marks a test request, so the SSR errors of exactly that request reach its response. */
export const SSR_TEST_HEADER = 'x-bespoke-test-render';

/** What server rendering did for one response (`createTestApp(…, { ssr: true })`). */
export interface SsrOutcome {
  /** Errors while rendering — in the shell (the page went out without markup) or after it. */
  readonly errors: readonly unknown[];
  /** The document rendered again from the page object as the browser reads it: what hydration compares against. */
  readonly rerendered: string | undefined;
}

/**
 * Server rendering for tests, through the app's Vite setup (as `bespoke dev` renders): `<Head>` and markup become
 * testable. Every page is rendered completely — like for a bot — so the markup does not depend on timing; with
 * `stream`, as for a browser (the shell first, the rest as it is ready).
 */
export class TestSsr {
  readonly renderer: PageRenderer;
  readonly #close: () => Promise<void>;
  readonly #errors = new Map<string, unknown[]>();
  /** What each render's islands resolved to (E49) — the browser renders them again from that, not from a request. */
  readonly #islands = new Map<string, Map<string, RegionResult>>();
  #next = 0;

  private constructor(renderer: PageRenderer, close: () => Promise<void>, { stream = false }: { stream?: boolean } = {}) {
    this.#close = close;
    const record = (request: Request, error: unknown) => {
      const id = request.headers.get(SSR_TEST_HEADER);
      if (id) this.#errors.get(id)?.push(error);
    };
    const islands = this.#islands;
    this.renderer = {
      ...renderer,
      async render(page, request, options) {
        const id = request.headers.get(SSR_TEST_HEADER);
        const { resolveIsland } = options;
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
                    if (id) islands.get(id)?.set(url, result);
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
      shell: (page, request) => renderer.shell(page, request),
    };
  }

  static async start(root: string, options: { stream?: boolean } = {}): Promise<TestSsr> {
    const { vite, renderer } = await createViteDevRenderer({ root });
    return new TestSsr(renderer, () => vite.close(), options);
  }

  /** A fresh id for the next request — send it as {@link SSR_TEST_HEADER}. */
  begin(): string {
    const id = String(this.#next++);
    this.#errors.set(id, []);
    this.#islands.set(id, new Map());
    return id;
  }

  /** What happened while rendering request `id`, and the page rendered again from its JSON (the browser's view of it). */
  async finish(id: string, url: string, page: PageObject | undefined): Promise<SsrOutcome> {
    const errors = this.#errors.get(id) ?? [];
    const islands = this.#islands.get(id) ?? new Map<string, RegionResult>();
    this.#errors.delete(id);
    this.#islands.delete(id);
    if (!page || errors.length > 0) return { errors, rerendered: undefined };
    const noop = () => {};
    // The browser's view: its islands as the server streamed them (E49) — never asked for again.
    const resolveIsland = async (island: string): Promise<RegionResult> => islands.get(island) ?? { status: 'browser' };
    const document = await this.renderer
      .render(JSON.parse(JSON.stringify(page)) as PageObject, new Request(url), { complete: true, onError: noop, onWarning: noop, resolveIsland })
      .catch(() => undefined);
    return { errors, rerendered: typeof document === 'string' ? document : undefined };
  }

  close(): Promise<void> {
    return this.#close();
  }
}

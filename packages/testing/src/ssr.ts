import type { PageObject } from '@bespokecore/http/page';
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
 * testable. Every page is rendered completely — like for a bot — so the markup does not depend on timing.
 */
export class TestSsr {
  readonly renderer: PageRenderer;
  readonly #close: () => Promise<void>;
  readonly #errors = new Map<string, unknown[]>();
  #next = 0;

  private constructor(renderer: PageRenderer, close: () => Promise<void>) {
    this.#close = close;
    const record = (request: Request, error: unknown) => {
      const id = request.headers.get(SSR_TEST_HEADER);
      if (id) this.#errors.get(id)?.push(error);
    };
    this.renderer = {
      ...renderer,
      async render(page, request, options) {
        try {
          const document = await renderer.render(page, request, {
            ...options,
            complete: true,
            onError: (error) => {
              record(request, error);
              options.onError(error);
            },
          });
          return typeof document === 'string' ? document : await new Response(document).text();
        } catch (error) {
          record(request, error);
          throw error;
        }
      },
      shell: (page, request) => renderer.shell(page, request),
    };
  }

  static async start(root: string): Promise<TestSsr> {
    const { vite, renderer } = await createViteDevRenderer({ root });
    return new TestSsr(renderer, () => vite.close());
  }

  /** A fresh id for the next request — send it as {@link SSR_TEST_HEADER}. */
  begin(): string {
    const id = String(this.#next++);
    this.#errors.set(id, []);
    return id;
  }

  /** What happened while rendering request `id`, and the page rendered again from its JSON (the browser's view of it). */
  async finish(id: string, url: string, page: PageObject | undefined): Promise<SsrOutcome> {
    const errors = this.#errors.get(id) ?? [];
    this.#errors.delete(id);
    if (!page || errors.length > 0) return { errors, rerendered: undefined };
    const noop = () => {};
    const document = await this.renderer
      .render(JSON.parse(JSON.stringify(page)) as PageObject, new Request(url), { complete: true, onError: noop, onWarning: noop })
      .catch(() => undefined);
    return { errors, rerendered: typeof document === 'string' ? document : undefined };
  }

  close(): Promise<void> {
    return this.#close();
  }
}

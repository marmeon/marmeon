import { once, SharedData, type HttpContext, type Next } from '@marmeon/http';
import { DocsRepository, type Navigation } from '../DocsRepository.ts';

declare module '@marmeon/http/page' {
  interface SharedProps {
    /**
     * The side navigation. Optional on purpose: a path without a route (a 404) passes no group's middleware, so its error
     * page has no shared props — the layout renders without the navigation then.
     */
    nav?: Navigation;
  }
}

/**
 * Shares the navigation with every page of the `docs` group — once: sent with the first page of a tab, then kept by
 * the browser; the server skips it while the tab holds it.
 */
export class ShareNavigation {
  readonly #shared: SharedData;
  readonly #docs: DocsRepository;

  constructor(shared: SharedData, docs: DocsRepository) {
    this.#shared = shared;
    this.#docs = docs;
  }

  handle(_ctx: HttpContext, next: Next<{}>) {
    this.#shared.share('nav', once(() => this.#docs.navigation()));
    return next();
  }
}

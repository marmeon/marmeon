import { once, SharedData, type HttpContext, type Next } from '@marmeon/http';
import { SiteConfig } from '../../../config/site.ts';

declare module '@marmeon/http/page' {
  interface SharedProps {
    /** The Fathom site id of a production document, for the SSR entry to write the script into the head. Never set otherwise. */
    fathomSite?: string;
  }
}

/** Global middleware (see SiteServiceProvider): hands the configured Fathom site to the SSR entry, which cannot read the config. */
export class ShareAnalytics {
  readonly #shared: SharedData;
  readonly #site: string | undefined;

  constructor(shared: SharedData, config: SiteConfig) {
    this.#shared = shared;
    this.#site = config.fathomSite;
  }

  handle(_ctx: HttpContext, next: Next<{}>) {
    const site = this.#site;
    if (site !== undefined) this.#shared.share('fathomSite', once(() => site));
    return next();
  }
}

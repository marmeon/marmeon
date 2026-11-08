import { once, SharedData, type HttpContext, type Next } from '@marmeon/http';
import { SiteInfo } from '../SiteInfo.ts';

declare module '@marmeon/http/page' {
  interface SharedProps {
    /**
     * What the website says about itself. Optional on purpose: a path without a route (a 404) passes no group's
     * middleware, so its error page has no shared props.
     */
    site?: { version: string; license: string; origin: string };
  }
}

/** Shares the framework's version and license and the site's origin (`APP_URL`, for structured data) with every page of the `public` group — once: kept by the browser after the first page of a tab. */
export class ShareSite {
  readonly #shared: SharedData;
  readonly #info: SiteInfo;

  constructor(shared: SharedData, info: SiteInfo) {
    this.#shared = shared;
    this.#info = info;
  }

  handle(_ctx: HttpContext, next: Next<{}>) {
    this.#shared.share('site', once(() => ({ version: this.#info.version, license: this.#info.license, origin: this.#info.origin })));
    return next();
  }
}

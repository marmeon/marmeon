import { once, SharedData, type HttpContext, type Next } from '@marmeon/http';
import { AppConfig } from '../../../config/app.ts';
import { publicUrl } from '../public-url.ts';
import { SiteInfo } from '../SiteInfo.ts';

declare module '@marmeon/http/page' {
  interface SharedProps {
    /**
     * What the website says about itself. Optional on purpose: a path without a route (a 404) passes no group's
     * middleware, so its error page has no shared props. `url` is the site's root from APP_URL: canonical URLs are built from it,
     * never from the request.
     */
    site?: { version: string; url: string };
  }
}

/** Shares the framework's version and the site's root URL with every page of the `public` group — once: kept by the browser after the first page of a tab. */
export class ShareSite {
  readonly #shared: SharedData;
  readonly #info: SiteInfo;
  readonly #app: AppConfig;

  constructor(shared: SharedData, info: SiteInfo, app: AppConfig) {
    this.#shared = shared;
    this.#info = info;
    this.#app = app;
  }

  handle(_ctx: HttpContext, next: Next<{}>) {
    this.#shared.share('site', once(() => ({ version: this.#info.version, url: publicUrl(this.#app, '/') })));
    return next();
  }
}

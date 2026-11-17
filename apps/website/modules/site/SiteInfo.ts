import type { MenuPanel } from './menu.ts';

/** What the website knows about itself at boot: the framework it runs on and the origin it is served from. */
export class SiteInfo {
  readonly version: string;
  /** The SPDX identifier of the framework's license, from `@marmeon/core`'s manifest. */
  readonly license: string;
  /** The scheme and host of `APP_URL` — never of a request. */
  readonly origin: string;
  /** The landing's mega menu, built once at boot from the docs' pages, the packages and the site's links. */
  readonly menu: readonly MenuPanel[];

  constructor(version: string, license: string, origin: string, menu: readonly MenuPanel[]) {
    this.version = version;
    this.license = license;
    this.origin = origin;
    this.menu = menu;
  }
}

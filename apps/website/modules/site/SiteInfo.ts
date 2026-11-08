/** What the website knows about itself at boot: the framework it runs on and the origin it is served from. */
export class SiteInfo {
  readonly version: string;
  /** The SPDX identifier of the framework's license, from `@marmeon/core`'s manifest. */
  readonly license: string;
  /** The scheme and host of `APP_URL` — never of a request. */
  readonly origin: string;

  constructor(version: string, license: string, origin: string) {
    this.version = version;
    this.license = license;
    this.origin = origin;
  }
}

/** What the website knows about itself at boot: the version of the framework it runs on. */
export class SiteInfo {
  readonly version: string;

  constructor(version: string) {
    this.version = version;
  }
}

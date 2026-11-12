/** One page of the help. `path` is its address below `/help`, with `/` between nested pages. */
export interface HelpPage {
  readonly path: string;
  readonly title: string;
  readonly body: string;
}

const PAGES: readonly HelpPage[] = [
  { path: 'getting-started', title: 'Getting started', body: 'Create an account, then open the dashboard.' },
  { path: 'getting-started/install', title: 'Install', body: 'Install the packages with pnpm and run the app with marmeon dev.' },
  { path: 'accounts/passkeys', title: 'Passkeys', body: 'Sign in with your device instead of a password.' },
];

/** The help pages: a fixed list, the same for everyone. */
export class HelpPages {
  all(): readonly HelpPage[] {
    return PAGES;
  }

  /** The page at this path (`getting-started/install`), if there is one. */
  find(path: string): HelpPage | undefined {
    return PAGES.find((page) => page.path === path);
  }
}

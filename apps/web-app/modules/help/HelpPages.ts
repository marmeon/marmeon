/** One page of the help. `path` is its address below `/:locale/help`, with `/` between nested pages. */
export interface HelpPage {
  readonly path: string;
  readonly title: string;
  readonly body: string;
}

/** The pages in each language: the same addresses everywhere, since the automatic language versions of a page assume one (the fallback itself could serve another path per language through `(locale, path)`). */
const PAGES: Readonly<Record<string, readonly HelpPage[]>> = {
  en: [
    { path: 'getting-started', title: 'Getting started', body: 'Create an account, then open the dashboard.' },
    { path: 'getting-started/install', title: 'Install', body: 'Install the packages with pnpm and run the app with marmeon dev.' },
    { path: 'accounts/passkeys', title: 'Passkeys', body: 'Sign in with your device instead of a password.' },
  ],
  de: [
    { path: 'getting-started', title: 'Erste Schritte', body: 'Legen Sie ein Konto an und öffnen Sie dann das Dashboard.' },
    { path: 'getting-started/install', title: 'Installation', body: 'Installieren Sie die Pakete mit pnpm und starten Sie die App mit marmeon dev.' },
    { path: 'accounts/passkeys', title: 'Passkeys', body: 'Melden Sie sich mit Ihrem Gerät an statt mit einem Passwort.' },
  ],
};

/** The help pages: a fixed list per language, the same for everyone. */
export class HelpPages {
  /** The pages in a language; none for one the help lacks. */
  all(locale: string): readonly HelpPage[] {
    return PAGES[locale] ?? [];
  }

  /** The page at this path (`getting-started/install`) in a language, if there is one. */
  find(locale: string, path: string): HelpPage | undefined {
    return this.all(locale).find((page) => page.path === path);
  }
}

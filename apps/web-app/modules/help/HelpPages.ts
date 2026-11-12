/** One page of the help. `id` names it in every language; `path` is its address below `/:locale/help`, with `/` between nested pages — and differs per language. */
export interface HelpPage {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly body: string;
}

/** The pages in each language, each with the address its language gives it. */
const PAGES: Readonly<Record<string, readonly HelpPage[]>> = {
  en: [
    { id: 'start', path: 'getting-started', title: 'Getting started', body: 'Create an account, then open the dashboard.' },
    { id: 'install', path: 'getting-started/install', title: 'Install', body: 'Install the packages with pnpm and run the app with marmeon dev.' },
    { id: 'passkeys', path: 'accounts/passkeys', title: 'Passkeys', body: 'Sign in with your device instead of a password.' },
  ],
  de: [
    { id: 'start', path: 'erste-schritte', title: 'Erste Schritte', body: 'Legen Sie ein Konto an und öffnen Sie dann das Dashboard.' },
    { id: 'install', path: 'erste-schritte/installation', title: 'Installation', body: 'Installieren Sie die Pakete mit pnpm und starten Sie die App mit marmeon dev.' },
    { id: 'passkeys', path: 'konto/passkeys', title: 'Passkeys', body: 'Melden Sie sich mit Ihrem Gerät an statt mit einem Passwort.' },
  ],
};

/** The help pages: a fixed list per language, the same for everyone. */
export class HelpPages {
  /** The languages the help is in. */
  languages(): readonly string[] {
    return Object.keys(PAGES);
  }

  /** The pages in a language; none for one the help lacks. */
  all(locale: string): readonly HelpPage[] {
    return PAGES[locale] ?? [];
  }

  /** The page at this path (`getting-started/install`) in a language, if there is one. */
  find(locale: string, path: string): HelpPage | undefined {
    return this.all(locale).find((page) => page.path === path);
  }

  /** The page at this path in whichever language gives it that address: how a visitor who followed another language's link is found. */
  findInAnyLanguage(path: string): HelpPage | undefined {
    for (const locale of this.languages()) {
      const page = this.find(locale, path);
      if (page) return page;
    }
    return undefined;
  }

  /** The same page in another language, if the help has it there. */
  inLanguage(page: HelpPage, locale: string): HelpPage | undefined {
    return this.all(locale).find((other) => other.id === page.id);
  }

  /** The page in every language that has it, by language. */
  versionsOf(page: HelpPage): Readonly<Record<string, HelpPage>> {
    return Object.fromEntries(this.languages().flatMap((locale) => {
      const version = this.inLanguage(page, locale);
      return version ? [[locale, version] as const] : [];
    }));
  }
}

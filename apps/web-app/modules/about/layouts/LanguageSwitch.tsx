import { Link, useAlternates } from '@marmeon/react';

const nameOf = (locale: string) => new Intl.DisplayNames([locale], { type: 'language' }).of(locale) ?? locale;

/** The same page in the app's other languages — links, so a visit changes the language of the URL and keeps the saved choice. */
export function LanguageSwitch({ label }: { label: string }) {
  const alternates = useAlternates();
  return (
    <nav aria-label={label} className="row row-tight">
      {alternates.map(({ locale, url, current }) =>
        current ? (
          <span key={locale} lang={locale} aria-current="true">{nameOf(locale)}</span>
        ) : (
          <Link key={locale} href={url} hrefLang={locale} lang={locale}>{nameOf(locale)}</Link>
        ),
      )}
    </nav>
  );
}

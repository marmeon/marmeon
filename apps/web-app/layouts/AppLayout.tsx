import { Link, usePage, useTranslation, type LayoutProps } from '@bespokecore/react';

/** A language's name in itself — "Deutsch", "English" (the same in Node and the browser: both have ICU). */
const nameOf = (locale: string) => new Intl.DisplayNames([locale], { type: 'language' }).of(locale) ?? locale;

/**
 * Around every page (the default in `bootstrap/layouts.ts`): navigation, the language switcher and flash messages.
 * It stays mounted while you navigate (E35) — the account menu stays open, nothing re-renders from scratch.
 */
export function AppLayout({ children }: LayoutProps) {
  const { props, locale } = usePage();
  const { auth, flash, locales } = props;
  const user = auth.user;
  const t = useTranslation('app');

  return (
    <>
      <header style={{ display: 'flex', gap: 16, alignItems: 'baseline', justifyContent: 'space-between', borderBottom: '1px solid #ddd', paddingBottom: 8 }}>
        <strong>
          {user ? <Link route="user-profile.me">{t('name')}</Link> : <Link route="auth.login">{t('name')}</Link>}
        </strong>
        {/* A POST with the CSRF token (a GET would let any site switch it): the choice goes into the session. */}
        <nav aria-label={t('language')} style={{ display: 'flex', gap: 4 }}>
          {locales.map((code) =>
            code === locale ? (
              <strong key={code} lang={code} aria-current="true">
                {nameOf(code)}
              </strong>
            ) : (
              <Link key={code} route="locale.update" data={{ locale: code }} lang={code}>
                {nameOf(code)}
              </Link>
            ),
          )}
        </nav>
        {user ? (
          <details data-account-menu>
            <summary>{user.name}</summary>
            <nav aria-label={t('account')}>
              <ul>
                <li>
                  <Link route="user-profile.me">{t('profile')}</Link>
                </li>
                <li>
                  <Link route="auth.security">{t('settings')}</Link>
                </li>
                <li>
                  <Link route="auth.logout">{t('sign_out')}</Link>
                </li>
              </ul>
            </nav>
          </details>
        ) : (
          <nav aria-label={t('account')}>
            <Link route="auth.login">{t('sign_in')}</Link> · <Link route="auth.register">{t('register')}</Link>
          </nav>
        )}
      </header>
      {flash.status && <p role="status">{flash.status}</p>}
      {children}
    </>
  );
}

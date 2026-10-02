import { Link, usePage, useTranslation, type LayoutProps } from '@bespokecore/react';
import { Toasts } from './Toasts.tsx';

/** A language's name in itself — "Deutsch", "English" (the same in Node and the browser: both have ICU). */
const nameOf = (locale: string) => new Intl.DisplayNames([locale], { type: 'language' }).of(locale) ?? locale;

/**
 * Around every page (the default in `bootstrap/layouts.ts`): navigation, the language switcher and flash messages.
 * It stays mounted while you navigate (E35) — the account menu stays open, nothing re-renders from scratch.
 */
export function AppLayout({ children }: LayoutProps) {
  const { props, locale } = usePage();
  const { auth, locales } = props;
  const user = auth.user;
  const t = useTranslation('app');

  return (
    <>
      <header style={{ display: 'flex', gap: 16, alignItems: 'baseline', justifyContent: 'space-between', borderBottom: '1px solid #ddd', paddingBottom: 8 }}>
        <strong>
          {user ? <Link route="user-profile.me">{t('name')}</Link> : <Link route="auth.login">{t('name')}</Link>}
        </strong>
        {/* The link to the page on screen gets aria-current="page" and data-current by itself (E64). */}
        {user && (
          <nav aria-label={t('main')} style={{ display: 'flex', gap: 12 }}>
            <Link route="dashboard.show">{t('dashboard')}</Link>
            {/* Current for the list however it is searched or sorted (its route), not only for /people itself. */}
            <Link route="user-profile.people" activeMatch="user-profile.people">
              {t('people')}
            </Link>
          </nav>
        )}
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
                  {/* Current on every settings page — the security page and the tokens (a section, `activeMatch`). */}
                  <Link route="auth.security" activeMatch={['auth.security', 'auth.tokens', 'auth.tokens.create']}>
                    {t('settings')}
                  </Link>
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
      {children}
      {/* Flash messages (E60): each once, as a toast. */}
      <Toasts />
    </>
  );
}

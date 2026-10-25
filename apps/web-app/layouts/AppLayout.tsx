import { Form, Link, useNewVersion, usePage, useRouter, useTranslation, type LayoutProps } from '@marmeon/react';
import { useEffect, ViewTransition } from 'react';
import { Toasts } from './Toasts.tsx';

/** A language's name in itself — "Deutsch", "English" (the same in Node and the browser: both have ICU). */
const nameOf = (locale: string) => new Intl.DisplayNames([locale], { type: 'language' }).of(locale) ?? locale;

/**
 * Around every page (the default in `bootstrap/layouts.ts`): navigation, the language switcher and flash messages.
 * It stays mounted while you navigate — the account menu stays open, nothing re-renders from scratch.
 */
export function AppLayout({ children }: LayoutProps) {
  const { props, locale } = usePage();
  // The shared props are optional (`ShareAppProps`): the 404 of a path without a route has none — a guest's header then.
  const { auth, locales, bell } = props;
  const user = auth?.user ?? null;
  const t = useTranslation('app');

  return (
    <>
      <header className="app-header">
        <strong>
          {user ? <Link route="user-profile.me">{t('name')}</Link> : <Link route="auth.login">{t('name')}</Link>}
        </strong>
        {/* The link to the page on screen gets aria-current="page" and data-current by itself. */}
        {!user && (
          <nav aria-label={t('main')} className="row">
            <Link route="about.index" activeMatch="about.*">
              {t('about')}
            </Link>
          </nav>
        )}
        {user && (
          <nav aria-label={t('main')} className="row">
            {/* Instant visits: the page's placeholder shows at once, inside this layout — then the page. */}
            <Link route="dashboard.show" instant>
              {t('dashboard')}
            </Link>
            {/* Current for the list however it is searched or sorted (its route), not only for /people itself. */}
            <Link route="user-profile.people" activeMatch="user-profile.people" instant>
              {t('people')}
            </Link>
          </nav>
        )}
        {/* A POST with the CSRF token (a GET would let any site switch it): the choice goes into the session. An uncontrolled
            `<Form>`: the pressed button's `locale` is the field — without JavaScript a real form (`_token` included). */}
        {locales && (
          <Form route="locale.update" aria-label={t('language')} className="row row-tight">
            {(form) =>
              locales.map((code) =>
                code === locale ? (
                  <strong key={code} lang={code} aria-current="true">
                    {nameOf(code)}
                  </strong>
                ) : (
                  <button key={code} type="submit" {...form.field('locale')} value={code} lang={code} disabled={form.processing}>
                    {nameOf(code)}
                  </button>
                ),
              )
            }
          </Form>
        )}
        {/* The bell (a shared prop, counted on the server per page): a link to the list — no client code of its own. */}
        {user && bell && (
          <Link route="notifications.index" aria-label={t('bell', { count: bell.unread })} data-bell="">
            🔔{bell.unread > 0 && <span data-unread="">{bell.unread}</span>}
          </Link>
        )}
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
      <NewVersionBanner />
      {/* The page, apart from the layout: it slides on a page change — forward or back (styles/app.css). */}
      <ViewTransition name="page">{children}</ViewTransition>
      {/* Flash messages: each once, as a toast. */}
      <Toasts />
    </>
  );
}

/**
 * A new build is out. Nothing typed is lost: with unsaved changes (a guarded form), the page does not reload — this says
 * so instead, and the next visit loads the new version anyway. Without unsaved changes it reloads at once.
 */
function NewVersionBanner() {
  const t = useTranslation('app');
  const router = useRouter();
  useEffect(() => router.on('version', (event) => event.unsaved && event.preventDefault()), [router]);
  const waiting = useNewVersion();
  if (!waiting) return null;
  return (
    <p role="status" data-new-version="" className="notice">
      {t('new_version')}{' '}
      <button type="button" onClick={() => waiting.reload()}>
        {t('new_version_reload')}
      </button>
    </p>
  );
}

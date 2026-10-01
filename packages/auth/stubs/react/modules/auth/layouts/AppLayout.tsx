import { Link, usePage, useTranslation, type LayoutProps } from '@bespokecore/react';

/**
 * Navigation and flash messages around the auth pages: `Page.layout = AppLayout`. It stays mounted while
 * you navigate between pages that use it (E35). Make it the app's default with `createBespokeApp({ layout })`.
 */
export function AppLayout({ children }: LayoutProps) {
  const { auth, flash } = usePage().props;
  const t = useTranslation('auth');

  return (
    <>
      <header style={{ display: 'flex', gap: 16, justifyContent: 'space-between', borderBottom: '1px solid #ddd', paddingBottom: 8 }}>
        <strong>{auth.user ? <Link route="dashboard">{t('layout.dashboard')}</Link> : <Link route="auth.login">{t('layout.sign_in')}</Link>}</strong>
        {auth.user ? (
          <nav aria-label={t('layout.account')}>
            {auth.user.name} · <Link route="auth.security">{t('layout.settings')}</Link> · <Link route="auth.logout">{t('layout.sign_out')}</Link>
          </nav>
        ) : (
          <nav aria-label={t('layout.account')}>
            <Link route="auth.register">{t('layout.register')}</Link>
          </nav>
        )}
      </header>
      {flash.status && <p role="status">{flash.status}</p>}
      {children}
    </>
  );
}

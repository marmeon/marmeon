import { Link, useFlash, usePage, useTranslation, type LayoutProps } from '@bespokecore/react';
import { useState } from 'react';

/**
 * Navigation and flash messages around the auth pages: `Page.layout = AppLayout`. It stays mounted while
 * you navigate between pages that use it (E35). Make it the app's default with `createBespokeApp({ layout })`.
 */
export function AppLayout({ children }: LayoutProps) {
  // `auth` is missing on the 404 of a path without a route (no group's middleware ran) — a guest's header then.
  const user = usePage().props.auth?.user ?? null;
  const t = useTranslation('auth');

  return (
    <>
      <header style={{ display: 'flex', gap: 16, justifyContent: 'space-between', borderBottom: '1px solid #ddd', paddingBottom: 8 }}>
        <strong>{user ? <Link route="dashboard">{t('layout.dashboard')}</Link> : <Link route="auth.login">{t('layout.sign_in')}</Link>}</strong>
        {user ? (
          <nav aria-label={t('layout.account')}>
            {user.name} · <Link route="auth.security">{t('layout.settings')}</Link> · <Link route="auth.logout">{t('layout.sign_out')}</Link>
          </nav>
        ) : (
          <nav aria-label={t('layout.account')}>
            <Link route="auth.register">{t('layout.register')}</Link>
          </nav>
        )}
      </header>
      {children}
      <Toasts />
    </>
  );
}

/**
 * Every `toast` flash message (E60), once — from a redirect's page, an action's answer, a layer's close — in a live region,
 * until it is dismissed. Without JavaScript, the page's messages show in a `<noscript>` (the server renders it).
 */
function Toasts() {
  const t = useTranslation('auth');
  const [toasts, setToasts] = useState<readonly { id: string; message: string; kind: string }[]>([]);
  useFlash('toast', (toast, { id }) => setToasts((current) => [...current, { id, ...toast }]));
  const { flash } = usePage();
  return (
    <>
      <noscript>
        {flash
          ?.filter((message) => message.key === 'toast')
          .map((message) => (
            <p key={message.id}>{message.data.message}</p>
          ))}
      </noscript>
      <section aria-label={t('layout.notifications')} aria-live="polite">
        {toasts.map((toast) => (
          <p key={toast.id} role={toast.kind === 'error' ? 'alert' : undefined} data-toast={toast.kind}>
            {toast.message}{' '}
            <button type="button" aria-label={t('layout.dismiss')} onClick={() => setToasts((current) => current.filter((other) => other.id !== toast.id))}>
              ×
            </button>
          </p>
        ))}
      </section>
    </>
  );
}

import { Link, useFlash, usePage, useTranslation, type LayoutProps } from '@marmeon/react';
import { useState } from 'react';

/**
 * Navigation and flash messages around the auth pages: `Page.layout = AppLayout`. It stays mounted while
 * you navigate between pages that use it. Make it the app's default with `createMarmeonApp({ layout })`. Its look:
 * `modules/auth/auth.css` (classes, no inline styles — a strict `style-src` blocks none of it).
 */
export function AppLayout({ children }: LayoutProps) {
  // `auth` is missing on the 404 of a path without a route (no group's middleware ran) — a guest's header then.
  const user = usePage().props.auth?.user ?? null;
  const t = useTranslation('auth');

  return (
    <>
      <header className="auth-header">
        {user ? (
          <Link route="dashboard" className="auth-brand">
            {t('layout.dashboard')}
          </Link>
        ) : (
          <Link route="auth.login" className="auth-brand">
            {t('layout.sign_in')}
          </Link>
        )}
        {user ? (
          <nav aria-label={t('layout.account')} className="auth-nav">
            <span>{user.name}</span>
            <Link route="auth.security">{t('layout.settings')}</Link>
            <Link route="auth.logout" className="auth-link">
              {t('layout.sign_out')}
            </Link>
          </nav>
        ) : (
          <nav aria-label={t('layout.account')} className="auth-nav">
            <Link route="auth.register" className="button">
              {t('layout.register')}
            </Link>
          </nav>
        )}
      </header>
      <Toasts />
      {children}
    </>
  );
}

/**
 * Every `toast` flash message, once — from a redirect's page, an action's answer, a layer's close — in a live region,
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
            <p key={message.id} className="notice">
              {message.data.message}
            </p>
          ))}
      </noscript>
      <section aria-label={t('layout.notifications')} aria-live="polite" className="auth-toasts">
        {toasts.map((toast) => (
          <p key={toast.id} role={toast.kind === 'error' ? 'alert' : undefined} data-toast={toast.kind}>
            {toast.message}{' '}
            <button type="button" className="auth-toast-close" aria-label={t('layout.dismiss')} onClick={() => setToasts((current) => current.filter((other) => other.id !== toast.id))}>
              ×
            </button>
          </p>
        ))}
      </section>
    </>
  );
}

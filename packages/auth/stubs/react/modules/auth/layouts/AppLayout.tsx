import { Link, usePage, type LayoutProps } from '@bespokecore/react';

/**
 * Navigation and flash messages around the auth pages: `Page.layout = AppLayout`. It stays mounted while
 * you navigate between pages that use it (E35). Make it the app's default with `createBespokeApp({ layout })`.
 */
export function AppLayout({ children }: LayoutProps) {
  const { auth, flash } = usePage().props;

  return (
    <>
      <header style={{ display: 'flex', gap: 16, justifyContent: 'space-between', borderBottom: '1px solid #ddd', paddingBottom: 8 }}>
        <strong>{auth.user ? <Link route="dashboard">Dashboard</Link> : <Link route="auth.login">Sign in</Link>}</strong>
        {auth.user ? (
          <nav aria-label="Account">
            {auth.user.name} · <Link route="auth.security">Settings</Link> · <Link route="auth.logout">Sign out</Link>
          </nav>
        ) : (
          <nav aria-label="Account">
            <Link route="auth.register">Create an account</Link>
          </nav>
        )}
      </header>
      {flash.status && <p role="status">{flash.status}</p>}
      {children}
    </>
  );
}

import { Link, usePage, type LayoutProps } from '@bespokecore/react';

/**
 * Around every page (the default in `bootstrap/layouts.ts`): navigation and flash messages. It stays mounted
 * while you navigate (E35) — the account menu stays open, nothing re-renders from scratch.
 */
export function AppLayout({ children }: LayoutProps) {
  const { auth, flash } = usePage().props;
  const user = auth.user;

  return (
    <>
      <header style={{ display: 'flex', gap: 16, alignItems: 'baseline', justifyContent: 'space-between', borderBottom: '1px solid #ddd', paddingBottom: 8 }}>
        <strong>
          {user ? <Link route="user-profile.me">BespokeCore</Link> : <Link route="auth.login">BespokeCore</Link>}
        </strong>
        {user ? (
          <details data-account-menu>
            <summary>{user.name}</summary>
            <nav aria-label="Account">
              <ul>
                <li>
                  <Link route="user-profile.me">Your profile</Link>
                </li>
                <li>
                  <Link route="auth.security">Settings</Link>
                </li>
                <li>
                  <Link route="auth.logout">Sign out</Link>
                </li>
              </ul>
            </nav>
          </details>
        ) : (
          <nav aria-label="Account">
            <Link route="auth.login">Sign in</Link> · <Link route="auth.register">Create an account</Link>
          </nav>
        )}
      </header>
      {flash.status && <p role="status">{flash.status}</p>}
      {children}
    </>
  );
}

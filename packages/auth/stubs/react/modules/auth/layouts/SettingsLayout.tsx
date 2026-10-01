import { Link, usePage, type LayoutProps } from '@bespokecore/react';

/** The settings pages, inside the app layout: `Page.layout = [AppLayout, SettingsLayout]`. */
export function SettingsLayout({ children }: LayoutProps) {
  const { component } = usePage();
  const current = (page: string) => (component === page ? 'page' : undefined);

  return (
    <div style={{ display: 'flex', gap: 32, alignItems: 'flex-start' }}>
      <nav aria-label="Settings" style={{ minWidth: 140, paddingTop: 16 }}>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, lineHeight: 2 }}>
          <li>
            <Link route="auth.security" aria-current={current('auth/Security')}>
              Security
            </Link>
          </li>
          <li>
            <Link route="auth.tokens" aria-current={current('auth/AccessTokens')}>
              API tokens
            </Link>
          </li>
        </ul>
      </nav>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}

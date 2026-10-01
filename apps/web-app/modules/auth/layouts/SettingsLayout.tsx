import { Link, usePage, useTranslation, type LayoutProps } from '@bespokecore/react';

/** The settings pages (`/settings/*`), inside the app layout: `Page.layout = [AppLayout, SettingsLayout]`. */
export function SettingsLayout({ children }: LayoutProps) {
  const { component } = usePage();
  const t = useTranslation('auth');
  const current = (page: string) => (component === page ? 'page' : undefined);

  return (
    <div style={{ display: 'flex', gap: 32, alignItems: 'flex-start' }}>
      <nav aria-label={t('settings.label')} style={{ minWidth: 140, paddingTop: 16 }}>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, lineHeight: 2 }}>
          <li>
            <Link route="auth.security" aria-current={current('auth/Security')}>
              {t('settings.security')}
            </Link>
          </li>
          <li>
            <Link route="auth.tokens" aria-current={current('auth/AccessTokens')}>
              {t('settings.tokens')}
            </Link>
          </li>
        </ul>
      </nav>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}

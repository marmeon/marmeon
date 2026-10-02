import { Link, useTranslation, type LayoutProps } from '@bespokecore/react';

/**
 * The settings pages (`/settings/*`), inside the app layout: `Page.layout = [AppLayout, SettingsLayout]`. The link to the
 * page on screen marks itself (`aria-current="page"`, `data-current` — E64); the tokens link also while a token is created.
 */
export function SettingsLayout({ children }: LayoutProps) {
  const t = useTranslation('auth');

  return (
    <div style={{ display: 'flex', gap: 32, alignItems: 'flex-start' }}>
      <nav aria-label={t('settings.label')} style={{ minWidth: 140, paddingTop: 16 }}>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, lineHeight: 2 }}>
          <li>
            <Link route="auth.security">
              {t('settings.security')}
            </Link>
          </li>
          <li>
            <Link route="auth.tokens" activeMatch="auth.tokens.*">
              {t('settings.tokens')}
            </Link>
          </li>
        </ul>
      </nav>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}

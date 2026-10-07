import { Link, useTranslation, type LayoutProps } from '@marmeon/react';

/**
 * The settings pages, inside the app layout: `Page.layout = [AppLayout, SettingsLayout]`. The link to the page on screen
 * marks itself — `aria-current="page"` and `data-current` (style it: `a[data-current] { font-weight: bold }`).
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
            <Link route="auth.tokens">
              {t('settings.tokens')}
            </Link>
          </li>
        </ul>
      </nav>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}

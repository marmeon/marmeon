import { Link, useTranslation, type LayoutProps } from '@marmeon/react';

/**
 * The settings pages, inside the app layout: `Page.layout = [AppLayout, SettingsLayout]`. The link to the page on screen
 * marks itself — `aria-current="page"` and `data-current` (style it in `modules/auth/auth.css`: `a[data-current] { font-weight: bold }`).
 */
export function SettingsLayout({ children }: LayoutProps) {
  const t = useTranslation('auth');

  return (
    <div className="auth-settings">
      <nav aria-label={t('settings.label')} className="auth-settings-nav">
        <ul>
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
      <div className="auth-settings-page">{children}</div>
    </div>
  );
}

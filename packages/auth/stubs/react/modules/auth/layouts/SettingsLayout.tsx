import { Link, useTranslation, type LayoutProps } from '@marmeon/react';

/**
 * The settings pages, inside the app layout: `Page.layout = [AppLayout, SettingsLayout]`. The link to the page on screen
 * marks itself — `aria-current="page"` and `data-current` (`modules/auth/auth.css` styles it: `.auth-settings-nav a[data-current]`).
 */
export function SettingsLayout({ children }: LayoutProps) {
  const t = useTranslation('auth');

  return (
    <div className="auth-settings app-main">
      <nav aria-label={t('settings.label')} className="auth-settings-nav">
        <ul>
          <li>
            <Link route="auth.security">
              {t('settings.security')}
            </Link>
          </li>
          <li>
            <Link route="auth.two-factor" activeMatch="auth.two-factor.*">
              {t('settings.two_factor')}
            </Link>
          </li>
          <li>
            <Link route="auth.passkeys" activeMatch="auth.passkeys.*">
              {t('settings.passkeys')}
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

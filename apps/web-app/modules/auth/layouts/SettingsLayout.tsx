import { Link, useTranslation, type LayoutProps } from '@marmeon/react';

/**
 * The settings pages (`/settings/*`), inside the app layout: `Page.layout = [AppLayout, SettingsLayout]`. The link to the
 * page on screen marks itself (`aria-current="page"`, `data-current`); the tokens link also while a token is created.
 */
export function SettingsLayout({ children }: LayoutProps) {
  const t = useTranslation('auth');

  return (
    <div className="settings">
      <nav aria-label={t('settings.label')} className="settings-nav">
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
            <Link route="auth.tokens" activeMatch="auth.tokens.*">
              {t('settings.tokens')}
            </Link>
          </li>
        </ul>
      </nav>
      <div className="settings-page">{children}</div>
    </div>
  );
}

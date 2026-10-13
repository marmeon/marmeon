import type { PageProps } from '@marmeon/http';
import { Head, Link, useTranslation } from '@marmeon/react';
import type { ShowDashboardController } from '../controllers/ShowDashboardController.ts';
import { AppLayout } from '../layouts/AppLayout.tsx';

type Props = PageProps<ShowDashboardController>;

export default function Dashboard({ name, verified }: Props) {
  const t = useTranslation('auth');
  return (
    <main className="app-main">
      <Head title={t('dashboard.title')} />
      <h1>{t('dashboard.title')}</h1>
      <p className="muted">{t('dashboard.welcome', { name })}</p>
      {!verified && (
        // A <div>, not a <p>: the link sends (a POST), so it renders a form — which a <p> cannot hold.
        <div role="note" className="notice cluster">
          <span>{t('dashboard.verify')}</span>
          <Link route="auth.verification.send" className="button-secondary">
            {t('dashboard.verify_again')}
          </Link>
        </div>
      )}
      <ul className="auth-shortcuts">
        <li className="card">
          <Link route="auth.security">{t('settings.security')}</Link>
        </li>
        <li className="card">
          <Link route="auth.tokens">{t('settings.tokens')}</Link>
        </li>
      </ul>
    </main>
  );
}

Dashboard.layout = AppLayout;

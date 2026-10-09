import type { PageProps } from '@marmeon/http';
import { Head, Link, useTranslation } from '@marmeon/react';
import type { ShowDashboardController } from '../controllers/ShowDashboardController.ts';
import { AppLayout } from '../layouts/AppLayout.tsx';

type Props = PageProps<ShowDashboardController>;

export default function Dashboard({ name, verified }: Props) {
  const t = useTranslation('auth');
  return (
    <main>
      <Head title={t('dashboard.title')} />
      <h1>{t('dashboard.title')}</h1>
      <p>{t('dashboard.welcome', { name })}</p>
      {!verified && (
        // A <div>, not a <p>: the link sends (a POST), so it renders a form — which a <p> cannot hold.
        <div role="note" className="auth-paragraph">
          {t('dashboard.verify')} <Link route="auth.verification.send">{t('dashboard.verify_again')}</Link>
        </div>
      )}
      <p>
        <Link route="auth.security">{t('settings.security')}</Link> · <Link route="auth.tokens">{t('settings.tokens')}</Link>
      </p>
    </main>
  );
}

Dashboard.layout = AppLayout;

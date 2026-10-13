import { Head, Link, useTranslation } from '@marmeon/react';
import { AppLayout } from '../layouts/AppLayout.tsx';

/** After a sign-up: the same for every address — what happens next is in the mail. */
export default function RegistrationSent() {
  const t = useTranslation('auth');
  return (
    <main className="app-main">
      <div className="card auth-card">
        <Head title={t('register.sent_title')} />
        <h1>{t('register.sent_title')}</h1>
        <p className="muted">{t('register.sent_intro')}</p>
        <p className="muted">{t('register.sent_missing')}</p>
        <p className="auth-card-footer">
          <Link route="auth.login">{t('register.login')}</Link>
        </p>
      </div>
    </main>
  );
}

RegistrationSent.layout = AppLayout;

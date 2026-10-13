import type { PageProps } from '@marmeon/http';
import { Head, Link, useTranslation } from '@marmeon/react';
import type { ShowVerifyEmailNoticeController } from '../controllers/ShowVerifyEmailNoticeController.ts';
import { AppLayout } from '../layouts/AppLayout.tsx';

type Props = PageProps<ShowVerifyEmailNoticeController>;

export default function VerifyEmail({ email }: Props) {
  const t = useTranslation('auth');
  return (
    <main className="app-main">
      <div className="card auth-card">
        <Head title={t('verify.title')} />
        <h1>{t('verify.title')}</h1>
        <p>{t('verify.intro', { email })}</p>
        {/* A <div>, not a <p>: the first link sends (a POST), so it renders a form — which a <p> cannot hold. */}
        <div className="auth-paragraph cluster">
          <Link route="auth.verification.send" className="button">
            {t('verify.resend')}
          </Link>
          <Link route="dashboard">{t('verify.back')}</Link>
        </div>
      </div>
    </main>
  );
}

VerifyEmail.layout = AppLayout;

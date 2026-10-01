import type { PageProps } from '@bespokecore/http';
import { Head, Link, useTranslation } from '@bespokecore/react';
import type { ShowVerifyEmailNoticeController } from '../controllers/ShowVerifyEmailNoticeController.ts';
import { AppLayout } from '../layouts/AppLayout.tsx';

type Props = PageProps<ShowVerifyEmailNoticeController>;

export default function VerifyEmail({ email }: Props) {
  const t = useTranslation('auth');
  return (
    <main>
      <Head title={t('verify.title')} />
      <h1>{t('verify.title')}</h1>
      <p>{t('verify.intro', { email })}</p>
      <p>
        <Link route="auth.verification.send">{t('verify.resend')}</Link> · <Link route="dashboard">{t('verify.back')}</Link>
      </p>
    </main>
  );
}

VerifyEmail.layout = AppLayout;

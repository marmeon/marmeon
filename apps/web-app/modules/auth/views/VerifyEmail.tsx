import type { PageProps } from '@bespokecore/http';
import { Head, Link, useTranslation } from '@bespokecore/react';
import type { ShowVerifyEmailNoticeController } from '../controllers/ShowVerifyEmailNoticeController.ts';

type Props = PageProps<ShowVerifyEmailNoticeController>;

export default function VerifyEmail({ email }: Props) {
  const t = useTranslation('auth');
  return (
    <main>
      <Head title={t('verify.title')} />
      <h1>{t('verify.title')}</h1>
      <p>{t('verify.intro', { email })}</p>
      <p>
        <Link route="auth.verification.send">{t('verify.resend')}</Link> · <Link route="user-profile.me">{t('verify.back')}</Link>
      </p>
    </main>
  );
}

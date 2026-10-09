import type { PageProps } from '@marmeon/http';
import { Head, Link, useTranslation } from '@marmeon/react';
import type { ShowVerifyEmailNoticeController } from '../controllers/ShowVerifyEmailNoticeController.ts';

type Props = PageProps<ShowVerifyEmailNoticeController>;

export default function VerifyEmail({ email }: Props) {
  const t = useTranslation('auth');
  return (
    <main>
      <Head title={t('verify.title')} />
      <h1>{t('verify.title')}</h1>
      <p>{t('verify.intro', { email })}</p>
      {/* A <div>, not a <p>: the first link sends (a POST), so it renders a form — which a <p> cannot hold. */}
      <div className="paragraph">
        <Link route="auth.verification.send">{t('verify.resend')}</Link> · <Link route="user-profile.me">{t('verify.back')}</Link>
      </div>
    </main>
  );
}

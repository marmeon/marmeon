import { Head, Link, useTranslation } from '@bespokecore/react';

/** After a sign-up (private registration, E146): the same for every address — what happens next is in the mail. */
export default function RegistrationSent() {
  const t = useTranslation('auth');
  return (
    <main>
      <Head title={t('register.sent_title')} />
      <h1>{t('register.sent_title')}</h1>
      <p>{t('register.sent_intro')}</p>
      <p>{t('register.sent_missing')}</p>
      <p>
        <Link route="auth.login">{t('register.login')}</Link>
      </p>
    </main>
  );
}

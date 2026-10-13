import { Head, Link, useTranslation } from '@marmeon/react';

export default function Sensitive() {
  const t = useTranslation('auth');

  return (
    <main>
      <Head title={t('two_factor.sensitive_title')} />
      <h1>{t('two_factor.sensitive_title')}</h1>
      <p>{t('two_factor.sensitive_intro')}</p>
      <p>
        <Link route="auth.two-factor">{t('two_factor.title')}</Link>
      </p>
    </main>
  );
}

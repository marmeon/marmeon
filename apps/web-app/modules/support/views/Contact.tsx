import type { PageProps } from '@marmeon/http';
import { Head, Link, useTranslation } from '@marmeon/react';
import type { ShowContactController } from '../controllers/ShowContactController.ts';

/** How to reach the support. */
export default function Contact({ email }: PageProps<ShowContactController>) {
  const t = useTranslation('support');
  return (
    <main>
      <Head title={t('title')} />
      <h1>{t('title')}</h1>
      <p>{t('write_to', { email })}</p>
      <p>
        <Link route="help.page">{t('all_pages')}</Link>
      </p>
    </main>
  );
}

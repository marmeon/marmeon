import type { PageProps } from '@marmeon/http';
import { Head, Link, useTranslation } from '@marmeon/react';
import type { ShowSecureController } from '../ShowSecureController.ts';

/** A page behind the editor's sudo window. */
export default function Secure(_: PageProps<ShowSecureController>) {
  const t = useTranslation('office');
  return (
    <main data-area="office">
      <Head title={t('secure.title')} />
      <h1>{t('secure.title')}</h1>
      <p>{t('secure.intro')}</p>
      <p>
        <Link route="office.index">{t('secure.back')}</Link>
      </p>
    </main>
  );
}

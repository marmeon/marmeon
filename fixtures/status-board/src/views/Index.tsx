import type { PageProps } from '@marmeon/http';
import { Head, Link, useTranslation } from '@marmeon/react';
import type { ShowStatusController } from '../ShowStatusController.ts';
import { StatusBoard } from '../StatusBoard.tsx';

/** The area's page: the board, and a link back to the app. */
export default function Index({ services }: PageProps<ShowStatusController>) {
  const t = useTranslation('status');
  return (
    <main data-area="status">
      <Head title={t('title')} />
      <h1>{t('title')}</h1>
      <p>{t('intro')}</p>
      <StatusBoard services={services} />
      <p>
        <Link route="dashboard.show">{t('back')}</Link>
      </p>
    </main>
  );
}

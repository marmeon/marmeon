import type { PageProps } from '@marmeon/http';
import { Head, Link, useTranslation } from '@marmeon/react';
import type { ShowOverviewController } from '../ShowOverviewController.ts';

/** The back office's page: a greeting, what the editor may do, and the pages of the own mode when there are any. */
export default function Overview({ name, users, canPublish }: PageProps<ShowOverviewController>) {
  const t = useTranslation('office');
  return (
    <main data-area="office">
      <Head title={t('overview.title')} />
      <h1>{t('overview.title')}</h1>
      <p>{t('overview.greeting', { name })}</p>
      <p>{users === 'own' ? t('overview.own') : t('overview.app')}</p>
      {canPublish ? <button type="button">{t('overview.publish')}</button> : <p>{t('overview.readOnly')}</p>}
      {users === 'own' && (
        <>
          <p>
            <Link route="office.sessions">{t('overview.sessions')}</Link> · <Link route="office.secure">{t('overview.secure')}</Link>
          </p>
          <div>
            <Link route="office.logout">{t('overview.logout')}</Link>
          </div>
        </>
      )}
    </main>
  );
}

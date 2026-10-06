import type { PageProps } from '@bespokecore/http';
import { Head, Island, Link, useTranslation, type Placeholder } from '@bespokecore/react';
import type { ShowDashboardController } from '../controllers/ShowDashboardController.ts';

type Props = PageProps<ShowDashboardController>;

/** How often "My activity" refreshes itself while it is on screen (ms). */
const ACTIVITY_POLL = 15_000;

const grid = { display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(16rem, 1fr))', alignItems: 'start' } as const;

/**
 * A page of islands (E48): the page renders at once, each panel loads by itself — in parallel, each through its own
 * route's middleware and authorization. On a full load the server resolves them in-process and streams them into the
 * same response (E49: no request from the browser); after a client-side visit the browser loads them. Back/Forward shows
 * them from memory, without a request.
 */
export default function Show(_props: Props) {
  const t = useTranslation('dashboard');
  const loading = <p aria-busy="true">{t('loading')}</p>;
  return (
    <main>
      <Head title={t('title')} />
      <h1>{t('title')}</h1>
      <p>{t('intro')}</p>
      <div style={grid}>
        <section aria-labelledby="sign-ins">
          <h2 id="sign-ins">{t('sign_ins.title')}</h2>
          {/* Its own query: the range picker inside reloads only this island (`useIsland().reload({ query })`). */}
          <Island route="dashboard.sign-ins" query={{ limit: 5 }} fallback={loading} />
        </section>
        <section aria-labelledby="members">
          <h2 id="members">{t('members.title')}</h2>
          {/* Administrators only (its route's authorization): anyone else sees the fallback — the page stays as it is. */}
          <Island route="dashboard.members" fallback={loading} unauthorized={<p>{t('members.hidden')}</p>} />
        </section>
      </div>
      <p>
        <Link route="user-profile.people">{t('people')}</Link>
        {' · '}
        {/* By URL, not by route name: a name client code writes goes into the route manifest of the first download (W9.5). */}
        <Link href="/members">{t('members_table')}</Link>
      </p>
      {/* Further down on purpose: it loads once it scrolls into view, then polls (paused while the tab is hidden). */}
      <section aria-labelledby="activity" style={{ marginTop: '70vh' }}>
        <h2 id="activity">{t('activity.title')}</h2>
        <Island route="dashboard.activity" load="visible" buffer={100} poll={ACTIVITY_POLL} fallback={loading} />
      </section>
    </main>
  );
}

/** The dashboard before its answer (E64, an instant visit from the main navigation): its title, the panels as they load. */
function DashboardPlaceholder() {
  const t = useTranslation('dashboard');
  return (
    <main aria-busy="true" data-placeholder="">
      <Head title={t('title')} />
      <h1>{t('title')}</h1>
      <p style={{ opacity: 0.5 }}>{t('loading')}</p>
    </main>
  );
}
Show.placeholder = DashboardPlaceholder satisfies Placeholder<ShowDashboardController>;

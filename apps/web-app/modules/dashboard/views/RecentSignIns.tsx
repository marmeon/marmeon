import type { IslandProps } from '@bespokecore/http';
import { Link, useIsland, useTranslation, type RevalidateOnBack } from '@bespokecore/react';
import type { ShowRecentSignInsController } from '../controllers/ShowRecentSignInsController.ts';

/** The ranges the picker offers — checked against the island's query schema by `reload({ query })`. */
const RANGES = ['7d', '30d', 'all'] as const;

/** Island "Recent sign-ins" (`dashboard.sign-ins`) — on the dashboard and on `/people`. */
export default function RecentSignIns({ entries, now }: IslandProps<ShowRecentSignInsController>) {
  const island = useIsland<ShowRecentSignInsController>();
  const t = useTranslation('dashboard');
  return (
    <>
      <p role="group" aria-label={t('sign_ins.range')} style={{ display: 'flex', gap: 4 }}>
        {RANGES.map((range) => (
          <button
            key={range}
            type="button"
            aria-pressed={island.query.range === range}
            data-pending={island.pending || undefined}
            onClick={() => void island.reload({ query: { range } })}
          >
            {t('sign_ins.range_option', { range })}
          </button>
        ))}
      </p>
      {entries.length === 0 ? (
        <p>{t('sign_ins.none')}</p>
      ) : (
        <ul>
          {entries.map((entry) => (
            <li key={entry.id}>
              {/* Links inside an island navigate the page (E51). */}
              <Link route="user-profile.show" params={{ user: entry.id }}>
                {entry.name}
              </Link>{' '}
              <small>
                <time dateTime={entry.at}>{t.format.relative(entry.at, now)}</time>
              </small>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// Back/Forward to the dashboard or `/people` shows this island from memory at once, then refreshes who signed in (E58).
RecentSignIns.revalidateOnBack = ['entries', 'now'] as const satisfies RevalidateOnBack<ShowRecentSignInsController>;

import type { IslandProps } from '@bespokecore/http';
import { useTranslation } from '@bespokecore/react';
import type { ShowMyActivityController } from '../controllers/ShowMyActivityController.ts';

/** Island "My activity" (`dashboard.activity`): loads when it scrolls into view, then polls. */
export default function MyActivity({ entries, now }: IslandProps<ShowMyActivityController>) {
  const t = useTranslation('dashboard');
  return (
    <>
      {entries.length === 0 ? (
        <p>{t('activity.none')}</p>
      ) : (
        <ul>
          {entries.map((entry, index) => (
            <li key={index}>
              {t('activity.entry', { kind: entry.kind, label: entry.label ?? '' })}{' '}
              <small>
                <time dateTime={entry.at}>{t.format.relative(entry.at, now)}</time>
              </small>
            </li>
          ))}
        </ul>
      )}
      <p>
        <small data-refreshed={now}>{t('activity.refreshed', { time: t.format.date(now, { timeStyle: 'medium', timeZone: 'UTC' }) })}</small>
      </p>
    </>
  );
}

import type { IslandProps } from '@marmeon/http';
import { Link, useTranslation } from '@marmeon/react';
import type { ShowMemberStatsController } from '../controllers/ShowMemberStatsController.ts';

/** Island "Members" (`dashboard.members`): for administrators only — its route decides, not this view. */
export default function MemberStats({ stats }: IslandProps<ShowMemberStatsController>) {
  const t = useTranslation('dashboard');
  return (
    <>
      <p>{t('members.text', { members: stats.members, verified: stats.verified })}</p>
      {stats.newest && (
        <p>
          {t('members.newest')}{' '}
          <Link route="user-profile.show" params={{ user: stats.newest.public_id }}>
            {stats.newest.name}
          </Link>
        </p>
      )}
    </>
  );
}

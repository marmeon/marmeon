import { withoutOverlapping, type JobPayload } from '@bespokecore/queue';
import * as v from 'valibot';
import { MemberStats } from '../MemberStats.ts';

/**
 * Counts the members again for the dashboard's snapshot (`MemberStats`). Queued as a unique job by `RefreshMemberStats`;
 * never two at once on any worker (`withoutOverlapping`) — a second one waits a few seconds and then counts the newest data.
 */
export class RebuildMemberStatsJob {
  static readonly job = 'user-profile.rebuild-member-stats';
  static readonly schema = v.object({});
  /** Waiting for another rebuild counts as an attempt. */
  static readonly tries = 5;
  static readonly timeout = 30;
  static readonly middleware = [withoutOverlapping('member-stats', { releaseAfter: 5 })];

  readonly #stats: MemberStats;

  constructor(stats: MemberStats) {
    this.#stats = stats;
  }

  async handle(_payload: JobPayload<typeof RebuildMemberStatsJob>): Promise<void> {
    await this.#stats.rebuild();
  }
}

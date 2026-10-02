import type { Registered } from '@bespokecore/auth';
import { Queue } from '@bespokecore/queue';
import { RebuildMemberStatsJob } from '../jobs/RebuildMemberStatsJob.ts';

/**
 * A new account changes the member numbers: queue a rebuild of the dashboard's snapshot.
 *
 * Unique (E85): ten registrations in a burst queue one rebuild, not ten — `dispatch()` is a no-op while one waits. Only
 * until it starts (`uniqueUntil: 'processing'`): a registration during a rebuild queues the next one, so the snapshot
 * never misses it. The registration runs in a transaction: the key's lock is taken on the cache's own connection and
 * freed again if the registration rolls back; the job row commits with the account.
 */
export class RefreshMemberStats {
  readonly #queue: Queue;

  constructor(queue: Queue) {
    this.#queue = queue;
  }

  async handle(_event: Registered): Promise<void> {
    await this.#queue.dispatch(RebuildMemberStatsJob, {}, { unique: 'members', uniqueUntil: 'processing', uniqueFor: 600 });
  }
}

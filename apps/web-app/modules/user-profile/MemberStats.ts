import { Cache } from '@marmeon/cache';
import { ProfileDirectory } from './ProfileDirectory.ts';

export type MemberNumbers = Awaited<ReturnType<ProfileDirectory['memberStats']>>;

/** Where the snapshot lives in the cache. */
const KEY = 'member-stats';
/** A snapshot older than this is computed again on read — what changes without a registration (a confirmed address) shows up by then. */
const MAX_AGE = 300;

/**
 * The member numbers of the dashboard's "Members" island as a snapshot in the cache — rebuilt by a queued job after a
 * registration (`RefreshMemberStats` → `RebuildMemberStatsJob`) instead of counting all users on every request of the
 * island.
 */
export class MemberStats {
  readonly #cache: Cache;
  readonly #directory: ProfileDirectory;

  constructor(cache: Cache, directory: ProfileDirectory) {
    this.#cache = cache;
    this.#directory = directory;
  }

  /** The snapshot — computed now when there is none (yet, or any more). */
  async current(): Promise<MemberNumbers> {
    return (await this.#cache.get<MemberNumbers>(KEY)) ?? this.rebuild();
  }

  /** Counts again and keeps the result. */
  async rebuild(): Promise<MemberNumbers> {
    const numbers = await this.#directory.memberStats();
    await this.#cache.put(KEY, numbers, MAX_AGE);
    return numbers;
  }
}

import { can } from '@bespokecore/auth';
import { Controller, defineRequest } from '@bespokecore/http';
import { MemberStats } from '#modules/user-profile';
import { DashboardConfig } from '../config.ts';
import { DashboardPolicy } from '../policies/DashboardPolicy.ts';

/** Its own authorization (E48): administrators only. Anyone else gets a 403 — which the island shows as its fallback. */
export const MemberStatsRequest = defineRequest({ authorize: can(DashboardPolicy, 'viewMembers') });

/** Island "Members": the member numbers — for administrators with a confirmed address (the route adds `verified()`). */
export class ShowMemberStatsController extends Controller {
  static request = MemberStatsRequest;

  readonly #stats: MemberStats;
  readonly #config: DashboardConfig;

  constructor(stats: MemberStats, config: DashboardConfig) {
    super();
    this.#stats = stats;
    this.#config = config;
  }

  async handle() {
    // Slow on purpose in development (DASHBOARD_ISLAND_DELAY): the other islands do not wait for it.
    if (this.#config.islandDelay > 0) await new Promise((done) => setTimeout(done, this.#config.islandDelay));
    // A snapshot in the cache, rebuilt by a queued job after each registration (MemberStats) — not a count per request.
    return this.island('dashboard/MemberStats', { stats: await this.#stats.current() });
  }
}

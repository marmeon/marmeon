import { can } from '@bespokecore/auth';
import { Controller, defineRequest } from '@bespokecore/http';
import { ProfileDirectory } from '#modules/user-profile';
import { DashboardConfig } from '../config.ts';
import { DashboardPolicy } from '../policies/DashboardPolicy.ts';

/** Its own authorization (E48): administrators only. Anyone else gets a 403 — which the island shows as its fallback. */
export const MemberStatsRequest = defineRequest({ authorize: can(DashboardPolicy, 'viewMembers') });

/** Island "Members": the member numbers — for administrators with a confirmed address (the route adds `verified()`). */
export class ShowMemberStatsController extends Controller {
  static request = MemberStatsRequest;

  readonly #directory: ProfileDirectory;
  readonly #config: DashboardConfig;

  constructor(directory: ProfileDirectory, config: DashboardConfig) {
    super();
    this.#directory = directory;
    this.#config = config;
  }

  async handle() {
    // Slow on purpose in development (DASHBOARD_ISLAND_DELAY): the other islands do not wait for it.
    if (this.#config.islandDelay > 0) await new Promise((done) => setTimeout(done, this.#config.islandDelay));
    return this.island('dashboard/MemberStats', { stats: await this.#directory.memberStats() });
  }
}

import type { Authenticated } from '@bespokecore/auth';
import { Controller, type HttpContext } from '@bespokecore/http';
import { ProfileActivity } from '#modules/user-profile';

/**
 * Island "My activity": the same read model as the profile's deferred panel (`ProfileActivity`) — here as an island
 * that loads when it scrolls into view and polls. Slow with `PROFILE_ACTIVITY_DELAY`, like the profile's.
 */
export class ShowMyActivityController extends Controller {
  readonly #activity: ProfileActivity;

  constructor(activity: ProfileActivity) {
    super();
    this.#activity = activity;
  }

  async handle(ctx: HttpContext<Authenticated>) {
    return this.island('dashboard/MyActivity', { entries: await this.#activity.recent(ctx.user.id, 8), now: new Date() });
  }
}

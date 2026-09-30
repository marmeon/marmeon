import type { UserLoggedIn } from '#modules/auth';
import { ProfileActivity } from '../ProfileActivity.ts';

/** Reacts to an auth event without the auth module knowing this module exists. */
export class RecordLastLogin {
  readonly #activity: ProfileActivity;

  constructor(activity: ProfileActivity) {
    this.#activity = activity;
  }

  handle(event: UserLoggedIn): void {
    this.#activity.recordLogin(event.user.id, event.at);
  }
}

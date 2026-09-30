import type { UserLoggedIn } from '#modules/auth';
import { LoginActivityRepository } from '../LoginActivityRepository.ts';

/** Reacts to an auth event without the auth module knowing this module exists. */
export class RecordLastLogin {
  readonly #activity: LoginActivityRepository;

  constructor(activity: LoginActivityRepository) {
    this.#activity = activity;
  }

  async handle(event: UserLoggedIn): Promise<void> {
    await this.#activity.record(event.user.id, event.at);
  }
}

import type { Login } from '@bespokecore/auth';
import { LoginActivityRepository } from '../LoginActivityRepository.ts';

/** Reacts to the framework's Login event — the auth module does not know this module exists. */
export class RecordLastLogin {
  readonly #activity: LoginActivityRepository;

  constructor(activity: LoginActivityRepository) {
    this.#activity = activity;
  }

  async handle(event: Login): Promise<void> {
    await this.#activity.record(event.user.id, event.at);
  }
}

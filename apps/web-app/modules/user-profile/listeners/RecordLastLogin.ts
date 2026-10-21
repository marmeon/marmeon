import type { SignedIn } from '@marmeon/auth';
import { Broadcaster } from '@marmeon/live';
import { LoginActivityRepository } from '../LoginActivityRepository.ts';
import { SIGN_INS_CHANNEL } from '../live.ts';

/** Reacts to the framework's SignedIn event — the auth module does not know this module exists. */
export class RecordLastLogin {
  readonly #activity: LoginActivityRepository;
  readonly #broadcast: Broadcaster;

  constructor(activity: LoginActivityRepository, broadcast: Broadcaster) {
    this.#activity = activity;
    this.#broadcast = broadcast;
  }

  async handle(event: SignedIn): Promise<void> {
    await this.#activity.record(event.user.id, event.at);
    // Live: the "Recent sign-ins" island on every open dashboard (and /people) reloads — after the commit, if any.
    await this.#broadcast.refresh(SIGN_INS_CHANNEL);
  }
}

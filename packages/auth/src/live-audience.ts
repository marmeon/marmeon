import type { LiveAudience } from '@marmeon/http';
import { Session } from '@marmeon/session';
import { GuardContext } from './guard-context.ts';
import { idOf } from './user.ts';

/**
 * The sign-in behind a live stream. The stream request is read-only: `Auth.user()` checks the fingerprint, the lifetime and the
 * `sign_ins` row without writing anything. A session that names an account nobody is signed in as any more is over. `Auth` is
 * resolved only for a session that names an account: a guest's stream never needs a `UserProvider`.
 */
export class SignInAudience implements LiveAudience {
  readonly #guard: GuardContext;
  readonly #session: Session;

  /** @internal Built by the container. */
  constructor(guard: GuardContext, session: Session) {
    this.#guard = guard;
    this.#session = session;
  }

  async check(): ReturnType<LiveAudience['check']> {
    if (!this.#session.started || !this.#session.has(this.#guard.names.session.id)) return { kind: 'guest' };
    const user = await this.#guard.auth().user();
    return user === undefined ? { kind: 'ended' } : { kind: 'account', scope: this.#guard.names.accountScope(String(idOf(user))) };
  }
}

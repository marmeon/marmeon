import type { LiveAudience } from '@marmeon/http';
import type { Session } from '@marmeon/session';
import { accountScope } from '@marmeon/session/internal';
import { AUTH_SESSION_KEYS, type Auth } from './auth.ts';
import { idOf } from './user.ts';

/**
 * The sign-in behind a live stream. The stream request is read-only: `Auth.user()` checks the fingerprint, the lifetime and the
 * `sign_ins` row without writing anything. A session that names an account nobody is signed in as any more is over. `Auth` is
 * resolved only for a session that names an account: a guest's stream never needs a `UserProvider`.
 */
export class SignInAudience implements LiveAudience {
  readonly #auth: () => Auth;
  readonly #session: Session;

  /** @internal Built by the container. */
  constructor(auth: () => Auth, session: Session) {
    this.#auth = auth;
    this.#session = session;
  }

  async check(): ReturnType<LiveAudience['check']> {
    if (!this.#session.started || !this.#session.has(AUTH_SESSION_KEYS.id)) return { kind: 'guest' };
    const user = await this.#auth().user();
    return user === undefined ? { kind: 'ended' } : { kind: 'account', scope: accountScope(String(idOf(user))) };
  }
}

import { Database } from '@bespokecore/database';
import { ProfileConfig } from './config.ts';

export interface ActivityEntry {
  readonly kind: 'joined' | 'signed-in' | 'link';
  /** ISO timestamp. */
  readonly at: string;
  /** The link's label, for `link`. */
  readonly label?: string;
}

/**
 * What someone did lately — joined, signed in, added links. Three queries over two modules' tables: the
 * profile page loads it after the page (a deferred prop), so the page never waits for it.
 */
export class ProfileActivity {
  readonly #db: Database<'user-profile'>;
  readonly #config: ProfileConfig;

  constructor(db: Database<'user-profile'>, config: ProfileConfig) {
    this.#db = db;
    this.#config = config;
  }

  async recent(userId: number, limit = 5): Promise<ActivityEntry[]> {
    if (this.#config.activityDelay > 0) await new Promise((done) => setTimeout(done, this.#config.activityDelay));
    const [user, login, links] = await Promise.all([
      this.#db.selectFrom('users').select('created_at').where('id', '=', userId).executeTakeFirst(),
      this.#db.selectFrom('login_activity').select('last_login_at').where('user_id', '=', userId).executeTakeFirst(),
      this.#db.selectFrom('profile_links').select(['label', 'created_at']).where('user_id', '=', userId).orderBy('created_at', 'desc').orderBy('id', 'desc').limit(limit).execute(),
    ]);
    const entries: ActivityEntry[] = [
      ...links.map((link) => ({ kind: 'link' as const, at: link.created_at, label: link.label })),
      ...(login ? [{ kind: 'signed-in' as const, at: login.last_login_at }] : []),
      ...(user ? [{ kind: 'joined' as const, at: user.created_at }] : []),
    ];
    return entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit);
  }
}

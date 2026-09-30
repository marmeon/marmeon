import { Database, hasOne, sql } from '@bespokecore/database';

/**
 * The module's read model: people with their last sign-in. `users` belongs to auth, which exposes it
 * for reading (E20); `login_activity` is this module's own table. Each read is one query — the last
 * sign-in is an eager-loaded relation, for one profile or the whole list (no N+1).
 */
export class ProfileDirectory {
  readonly #db: Database<'user-profile'>;

  constructor(db: Database<'user-profile'>) {
    this.#db = db;
  }

  profile(id: number) {
    return this.#db
      .selectFrom('users')
      .select((eb) => [
        'users.id',
        'users.name',
        'users.email',
        'users.bio',
        hasOne(eb, 'login_activity', 'user_id', 'users.id', (q) => q.select('login_activity.last_login_at')).as('activity'),
      ])
      .where('users.id', '=', id)
      .executeTakeFirst();
  }

  /** Everyone but `except`, by name — optionally only names containing `search` (LIKE wildcards taken literally). */
  people({ search = '', except }: { search?: string; except: number }) {
    let query = this.#db
      .selectFrom('users')
      .select((eb) => [
        'users.id',
        'users.name',
        hasOne(eb, 'login_activity', 'user_id', 'users.id', (q) => q.select('login_activity.last_login_at')).as('activity'),
      ])
      .where('users.id', '!=', except)
      .orderBy('users.name');
    if (search) {
      const pattern = `%${search.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      query = query.where(sql<boolean>`lower(users.name) like ${pattern} escape '\\'`);
    }
    return query.execute();
  }
}

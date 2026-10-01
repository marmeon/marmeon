import { cursorPaginate, Database, hasMany, hasOne, sql } from '@bespokecore/database';
import type { RouteBinder } from '@bespokecore/http';

/**
 * The module's read model: people with their last sign-in and links. It opts into module boundaries
 * (`Database<'user-profile'>`): `users` belongs to auth, which exposes it for reading only;
 * `login_activity` and `profile_links` are this module's own tables. Each
 * read is one query — relations are eager-loaded (no N+1). Also a route binder: `Route.bind('user', ProfileDirectory)`.
 */
export class ProfileDirectory implements RouteBinder<Profile> {
  readonly #db: Database<'user-profile'>;

  constructor(db: Database<'user-profile'>) {
    this.#db = db;
  }

  profile(id: number) {
    return this.#db
      .selectFrom('users')
      // The row as the migrations define it — its columns reach the view (the controller holds back the e-mail;
      // the connection leaves out the secret password hash).
      .selectAll('users')
      .select((eb) => [
        hasOne(eb, 'login_activity', 'user_id', 'users.id', (q) => q.select('login_activity.last_login_at')).as('activity'),
        hasMany(eb, 'profile_links', 'user_id', 'users.id', (q) =>
          q.select(['profile_links.id', 'profile_links.label', 'profile_links.url']).orderBy('profile_links.id'),
        ).as('links'),
      ])
      .where('users.id', '=', id)
      .executeTakeFirst();
  }

  /** `/users/:user` → the profile, or a 404. */
  resolveRouteBinding(value: string) {
    return /^\d{1,15}$/.test(value) ? this.profile(Number(value)) : undefined;
  }

  /**
   * Numbers about a profile: its links, and its place among the members (by sign-up). Counts over every user —
   * the profile page asks for them only on request (an optional prop).
   */
  async stats(id: number): Promise<{ links: number; memberNumber: number; members: number }> {
    const [links, rank] = await Promise.all([
      this.#db.selectFrom('profile_links').select((eb) => eb.fn.countAll<number>().as('count')).where('user_id', '=', id).executeTakeFirstOrThrow(),
      this.#db
        .selectFrom('users')
        .select((eb) => [
          eb.fn.countAll<number>().as('members'),
          eb.fn.sum<number>(sql<number>`case when users.id <= ${id} then 1 else 0 end`).as('memberNumber'),
        ])
        .executeTakeFirstOrThrow(),
    ]);
    return { links: Number(links.count), memberNumber: Number(rank.memberNumber), members: Number(rank.members) };
  }

  /**
   * The next people after `cursor` (from the query string — anything that does not decode starts at the top), by
   * name: everyone but `except`, optionally only names containing `search` (LIKE wildcards taken literally). Keyset
   * pagination on (name, id) — names repeat, ids break the tie — for "load more": no count, no offset, nobody twice.
   */
  people({ search = '', except, cursor, perPage = 5 }: { search?: string; except: number; cursor?: string | null; perPage?: number }) {
    let query = this.#db
      .selectFrom('users')
      .select((eb) => [
        'users.id',
        'users.name',
        hasOne(eb, 'login_activity', 'user_id', 'users.id', (q) => q.select('login_activity.last_login_at')).as('activity'),
      ])
      .where('users.id', '!=', except);
    if (search) {
      const pattern = `%${search.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      query = query.where(sql<boolean>`lower(users.name) like ${pattern} escape '\\'`);
    }
    return cursorPaginate(query, { column: ['name', 'id'], cursor, perPage });
  }
}

export type Profile = NonNullable<Awaited<ReturnType<ProfileDirectory['profile']>>>;

import { Database, paginate, sql } from '@marmeon/database';
import type { RouteBinder } from '@marmeon/http';

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
      .with('login_activity', { as: 'activity' }, (activity) => activity.select('last_login_at'))
      .with('profile_links', { as: 'links' }, (links) => links.select(['id', 'user_id', 'label', 'url']).orderBy('id'))
      .where('users.id', '=', id)
      .executeTakeFirst();
  }

  /** `/users/:user` → the profile, or a 404. */
  resolveRouteBinding(value: string) {
    return /^\d{1,15}$/.test(value) ? this.profile(Number(value)) : undefined;
  }

  /** A profile's links, oldest first — what the edit layer lists (and removes). */
  links(id: number) {
    return this.#db.selectFrom('profile_links').select(['id', 'user_id', 'label', 'url']).where('user_id', '=', id).orderBy('id').execute();
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
   * Who signed in lately — newest first, at most `limit`, since `since` (all time without). For the dashboard's
   * "Recent sign-ins" island; names and times only.
   */
  recentSignIns({ since, limit }: { since: Date | undefined; limit: number }) {
    let query = this.#db
      .selectFrom('login_activity')
      .innerJoin('users', 'users.id', 'login_activity.user_id')
      .select(['users.id', 'users.name', 'login_activity.last_login_at'])
      .orderBy('login_activity.last_login_at', 'desc')
      .orderBy('users.id', 'desc')
      .limit(limit);
    if (since) query = query.where('login_activity.last_login_at', '>=', since.toISOString());
    return query.execute();
  }

  /** How many members there are, how many confirmed their address, and who joined last — the dashboard's "Members" island. */
  async memberStats(): Promise<{ members: number; verified: number; newest: { id: number; name: string; created_at: string } | undefined }> {
    const [counts, newest] = await Promise.all([
      this.#db
        .selectFrom('users')
        .select((eb) => [
          eb.fn.countAll<number>().as('members'),
          eb.fn.count<number>('users.email_verified_at').as('verified'),
        ])
        .executeTakeFirstOrThrow(),
      this.#db.selectFrom('users').select(['users.id', 'users.name', 'users.created_at']).orderBy('users.id', 'desc').limit(1).executeTakeFirst(),
    ]);
    return { members: Number(counts.members), verified: Number(counts.verified), newest };
  }

  /**
   * The people of the list page (`/people`), as its query asks (`ListPeopleRequest`, already parsed): names containing
   * `q` (LIKE wildcards taken literally), in `sort` order — names repeat, ids break the tie — the page `page` of `per_page`
   * (with the total, for the page links). Sign-up order is the id's.
   */
  people({ q, sort, page = 1, per_page = 10 }: PeopleQuery) {
    let query = this.#db
      .selectFrom('users')
      .select(['users.id', 'users.name', 'users.avatar_path'])
      .with('login_activity', { as: 'activity' }, (activity) => activity.select('last_login_at'));
    if (q) {
      const pattern = `%${q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      query = query.where(sql<boolean>`lower(users.name) like ${pattern} escape '\\'`);
    }
    const direction = sort.startsWith('-') ? 'desc' : 'asc';
    query = sort.endsWith('name') ? query.orderBy('users.name', direction).orderBy('users.id', direction) : query.orderBy('users.id', direction);
    return paginate(this.#db, query, { page, per_page });
  }
}

/** How the people list sorts: by name, or by sign-up (`joined`) — `-` for descending. */
export const PEOPLE_SORTS = ['name', '-name', 'joined', '-joined'] as const;

/** What the people list asks for — the parsed query of `/people`. */
export interface PeopleQuery {
  readonly q: string;
  readonly sort: (typeof PEOPLE_SORTS)[number];
  readonly page?: number;
  readonly per_page?: number;
}

export type Profile = NonNullable<Awaited<ReturnType<ProfileDirectory['profile']>>>;

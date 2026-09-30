import { Repository, sql } from '@bespokecore/database';

/** Access to users — the auth module's public, injectable API (other modules only read `users` via `exposes`). */
export class UserRepository extends Repository<'users'> {
  static table = 'users' as const;
  static timestamps = true;

  /** Everyone's id and name, by name — optionally only names containing `search` (any case). */
  list({ search = '', except }: { search?: string; except?: number } = {}) {
    let query = this.query().select(['id', 'name']).orderBy('name');
    if (search) {
      // LIKE, with its wildcards in the search taken literally; lower() on both sides for Postgres.
      const pattern = `%${search.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      query = query.where(sql<boolean>`lower(name) like ${pattern} escape '\\'`);
    }
    if (except !== undefined) query = query.where('id', '!=', except);
    return query.execute();
  }
}

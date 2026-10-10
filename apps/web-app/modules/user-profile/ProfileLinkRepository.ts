import { Repository, type ExposedTables, type ModuleTables, type TableOwners, type Tables } from '@marmeon/database';

/** The links on people's profiles — this module's own table, seen through the module's view. Bound scoped to its user in the routes. */
export class ProfileLinkRepository extends Repository<'profile_links', ModuleTables<Tables, TableOwners, ExposedTables, 'user-profile'>> {
  static table = 'profile_links' as const;

  /** Removes every link of these users (moderation, the members table) — how many there were. */
  async removeAllOf(userIds: readonly number[]): Promise<number> {
    if (userIds.length === 0) return 0;
    const result = await this.db.deleteFrom('profile_links').where('user_id', 'in', userIds).executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}

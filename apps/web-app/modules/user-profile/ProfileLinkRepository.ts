import { err, ok, type Result } from '@marmeon/core';
import { Repository, type ExposedTables, type ModuleTables, type Row, type TableOwners, type Tables } from '@marmeon/database';

/** The links on people's profiles — this module's own table, seen through the module's view. Bound scoped to its user in the routes. */
export class ProfileLinkRepository extends Repository<'profile_links', ModuleTables<Tables, TableOwners, ExposedTables, 'user-profile'>> {
  static table = 'profile_links' as const;

  /** Removes every link of these users (moderation, the members table) — how many there were. */
  async removeAllOf(userIds: readonly number[]): Promise<number> {
    if (userIds.length === 0) return 0;
    const result = await this.db.deleteFrom('profile_links').where('user_id', 'in', userIds).executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  /**
   * Features a link and unfeatures its user's other one. The unique index `profile_links_one_featured_per_user` is what holds when two
   * requests race: the loser gets a `duplicate` err and nothing changes. `missing` when the link is gone.
   * `updated_at` is the version `renameIfCurrent()` compares, and featuring is no change of what a rename saw: the featured link and the
   * one it unfeatures both keep it. The featured link's version is read under the row lock, so a rename cannot land between the read and the write.
   */
  feature(link: Pick<Row<'profile_links'>, 'id' | 'user_id'>) {
    return this.transaction(async (links) => {
      const current = await links.query().select(['updated_at']).where('id', '=', link.id).forUpdate().executeTakeFirst();
      if (!current) return err({ kind: 'missing' } as const);
      // A query-builder write does not touch `updated_at`, which is what keeps the other link's version.
      await links.db
        .updateTable('profile_links')
        .set({ featured: false })
        .where('user_id', '=', link.user_id)
        .where('featured', '=', true)
        .where('id', '<>', link.id)
        .execute();
      return links.tryUpdate(link.id, { featured: true, updated_at: current.updated_at });
    });
  }

  /** Unfeatures a link, keeping its version (read under the row lock): its row, or a `missing` err when it is gone. */
  unfeature(id: Row<'profile_links'>['id']) {
    return this.transaction(async (links) => {
      const current = await links.query().select(['updated_at']).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!current) return err({ kind: 'missing' } as const);
      return links.tryUpdate(id, { featured: false, updated_at: current.updated_at });
    });
  }

  /**
   * Renames a link unless it changed since `seen` (the `updated_at` the caller read): then `err` holds the link as it is now. The row is
   * locked while it is compared, and the save moves its version past `seen` (at least `now`), so two saves with the same version
   * cannot both pass. `undefined` when the link is gone.
   * The version is a timestamp compared to the millisecond: the advance keeps two saves through this method apart, but a write from
   * outside that lands in the same millisecond as the link's stamp is not seen.
   */
  renameIfCurrent(id: Row<'profile_links'>['id'], label: string, seen: Date, now: Date): Promise<Result<Row<'profile_links'>, { readonly kind: 'stale'; readonly current: Row<'profile_links'> }> | undefined> {
    return this.transaction(async (links) => {
      const current = await links.query().selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!current) return undefined;
      if (new Date(current.updated_at).getTime() !== seen.getTime()) return err({ kind: 'stale', current } as const);
      // Strictly after the version the client saw: a save in the same millisecond as the row's stamp would leave the version unchanged,
      // and a second save with the same `seen` would pass too.
      const stamp = new Date(Math.max(now.getTime(), seen.getTime() + 1));
      return ok((await links.update(id, { label, updated_at: stamp.toISOString() }))!);
    });
  }
}

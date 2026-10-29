import { hashLinkToken, linkToken } from '@marmeon/encryption';
import { Repository, secretEquals, type Row } from '@marmeon/database';

/**
 * Links that open once: the table keeps the hash of each token (`linkToken()`), never the token. Also a route binder — the
 * `:link` of a path is the token, looked up by its hash through the unique index.
 */
export class OneTimeLinkRepository extends Repository<'lab_one_time_links'> {
  static table = 'lab_one_time_links' as const;

  /** A new link: the token comes back once, for the URL. */
  async create(): Promise<string> {
    const { token, hash } = linkToken();
    await this.insert({ token_hash: hash });
    return token;
  }

  /** `/lab/one-time-links/:link` → the row, or `undefined` (a 404) for a token that is wrong in shape, unknown or used up: one query, one answer. */
  override resolveRouteBinding(value: string): Promise<Row<'lab_one_time_links'> | undefined> {
    return this.query().selectAll().where((eb) => secretEquals(eb, 'token_hash', hashLinkToken(value))).where('used_at', 'is', null).executeTakeFirst();
  }

  /** The link of a session's invitation, unless it is used up since: looked up on every request, never trusted from the session. */
  findOpen(id: Row<'lab_one_time_links'>['id']): Promise<Row<'lab_one_time_links'> | undefined> {
    return this.query().selectAll().where('id', '=', id).where('used_at', 'is', null).executeTakeFirst();
  }

  /** Marks the link used — true for exactly one caller, however many arrive at once: the update itself decides. */
  async redeem(id: Row<'lab_one_time_links'>['id']): Promise<boolean> {
    const result = await this.db.updateTable('lab_one_time_links').set({ used_at: new Date() }).where('id', '=', id).where('used_at', 'is', null).executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }
}

import { Connections } from '@marmeon/database';
import { ProfileLinkRepository } from '#modules/user-profile';

/** Profile links a lab account may have. */
export const LAB_LINK_LIMIT = 3;

/**
 * Adds a profile link unless the account has {@link LAB_LINK_LIMIT} of them: it reads how many there are, then inserts, which is
 * only right when no other request does the same in between. The row of the account is locked for the transaction so that
 * the second request waits and counts again. A test of that lock needs `database: 'isolated'`, and proves itself by failing when the
 * `forUpdate()` is removed (docs/database-testing.md#testing-a-lock).
 */
export class LabLinks {
  readonly #connections: Connections;
  readonly #links: ProfileLinkRepository;

  constructor(connections: Connections, links: ProfileLinkRepository) {
    this.#connections = connections;
    this.#links = links;
  }

  add(userId: number): Promise<boolean> {
    return this.#connections.transaction(async () => {
      const db = this.#connections.get();
      await db.selectFrom('users').select('id').where('id', '=', userId).forUpdate().executeTakeFirstOrThrow();
      const held = await db.selectFrom('profile_links').select('id').where('user_id', '=', userId).execute();
      if (held.length >= LAB_LINK_LIMIT) return false;
      await this.#links.insert({ user_id: userId, label: `Link ${held.length + 1}`, url: `https://example.com/${held.length + 1}` });
      return true;
    });
  }
}

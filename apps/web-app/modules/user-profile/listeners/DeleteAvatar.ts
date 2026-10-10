import { afterCommit } from '@marmeon/core';
import { Storage } from '@marmeon/storage';
import type { AccountDeleted } from '#modules/auth';

/**
 * A deleted account's avatar goes too — after the deletion committed: a rollback keeps the account, and with it the
 * picture. Its profile links and sign-in activity go with the row (the foreign keys cascade).
 */
export class DeleteAvatar {
  readonly #storage: Storage;

  constructor(storage: Storage) {
    this.#storage = storage;
  }

  async handle(event: AccountDeleted): Promise<void> {
    const path = event.user.avatar_path;
    if (!path) return;
    await afterCommit(() => this.#storage.disk('public').delete(path).catch(() => false));
  }
}

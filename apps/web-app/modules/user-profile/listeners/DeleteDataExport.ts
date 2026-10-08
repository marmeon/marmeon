import { afterCommit } from '@marmeon/core';
import { Storage } from '@marmeon/storage';
import type { AccountDeleted } from '#modules/auth';
import { dataExportKey } from '../controllers/ExportMyDataController.ts';

/**
 * A deleted account's data export ("Download my data" — its address, name and links as JSON on the private disk) goes too (E203) —
 * after the deletion committed, like the avatar; `PruneDataExports` would take it within a quarter of an hour, this does not wait.
 */
export class DeleteDataExport {
  readonly #storage: Storage;

  constructor(storage: Storage) {
    this.#storage = storage;
  }

  async handle(event: AccountDeleted): Promise<void> {
    const key = dataExportKey(event.user.id);
    await afterCommit(() => this.#storage.disk('local').delete(key).catch(() => false));
  }
}

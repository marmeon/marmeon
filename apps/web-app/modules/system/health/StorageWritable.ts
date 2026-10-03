import type { HealthCheck } from '@bespokecore/core';
import { Storage } from '@bespokecore/storage';

/**
 * Readiness (E126): the private `local` disk takes a file and lets it go — uploads, the data export and the avatars live on
 * these disks. A full or read-only volume makes `/up/ready` answer 503, and the load balancer sends no more requests here.
 */
export class StorageWritable implements HealthCheck {
  static check = 'storage';

  readonly #storage: Storage;

  constructor(storage: Storage) {
    this.#storage = storage;
  }

  async handle(): Promise<string> {
    const disk = this.#storage.disk('local');
    const key = `.health/${crypto.randomUUID()}`;
    await disk.put(key, 'ok');
    await disk.delete(key);
    return 'local';
  }
}

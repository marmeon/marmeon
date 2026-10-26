import type { Container } from '@marmeon/core';
import type { CheckDiskName, DefaultDiskName, DiskFor, DiskNameInput, DiskOptions } from './config.ts';
import type { Disk } from './disk.ts';
import type { ExpectedContents } from './drivers/memory.ts';
import { type Storage, StorageManager } from './storage.ts';
import { StorageSetup } from './setup.ts';

/** A disk of the fake: the configured disk's type plus the memory disk's assertions. */
export type FakeDisk<N extends string> = DiskFor<N> & FakeDiskAssertions;

/** What the fake's in-memory disks add to a {@link Disk}: the files they hold and assertions on them (each returns the disk). */
export interface FakeDiskAssertions {
  /** Every key on the disk, sorted. */
  files(): string[];
  /** The file exists — with these contents (text, bytes, or a check), when given. */
  assertExists(key: string, contents?: ExpectedContents): this;
  assertMissing(key: string): this;
  /** The disk — or `directory`, recursively — holds exactly `count` files. */
  assertCount(count: number, directory?: string): this;
}

/** The manager of the fake: every disk is built in memory. */
class FakeManager extends StorageManager {
  protected override build(name: string, options: DiskOptions): Disk {
    return this.memory(name, options);
  }
}

/**
 * The storage of a test app (default in `createTestApp`, like the mail and queue fakes): every configured disk is an
 * in-memory disk with the configured name, visibility and URL — nothing touches the file system or S3, and each test
 * starts empty. Keys are checked as on every disk; `temporaryUrl()` signs real URLs the app's routes serve from memory.
 * Assert with `app.storage.disk('local').assertExists(key)`.
 */
export class StorageFake implements Storage {
  readonly #manager: FakeManager;

  /** @internal Built by the container. */
  constructor(container: Container) {
    const setup = container.make(StorageSetup);
    this.#manager = new FakeManager(setup.options, setup.dependencies);
  }

  get names(): readonly string[] {
    return this.#manager.names;
  }

  /** @internal Used by the storage provider. */
  get defaultDisk(): string {
    return this.#manager.defaultDisk;
  }

  disk<const N extends DiskNameInput = DefaultDiskName>(name?: CheckDiskName<N>): FakeDisk<N> {
    return this.#manager.disk(name) as FakeDisk<N>;
  }

  /**
   * The disk `name`, untyped — for names from configuration or the URL (an unknown one throws {@link StorageError}).
   * @internal Used by the storage provider and routes.
   */
  named(name: string): Disk {
    return this.#manager.named(name);
  }

  /**
   * The configuration of the disk `name` — or a {@link StorageError} with the known names.
   * @internal Used by the storage provider.
   */
  options(name: string): DiskOptions {
    return this.#manager.options(name);
  }

  /**
   * Builds every disk of a driver a provider brought; the fake's disks are all in memory, so nothing can fail.
   * @internal Used by the storage provider.
   */
  verify(): void {
    this.#manager.verify();
  }

  /**
   * Closes every built disk that has a `close()`.
   * @internal Used by the storage provider.
   */
  async close(): Promise<void> {
    await this.#manager.close();
  }
}

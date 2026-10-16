import type { Container } from '@marmeon/core';
import type { CheckDiskName, DefaultDiskName, DiskFor, DiskNameInput, DiskOptions } from './config.ts';
import type { Disk } from './disk.ts';
import type { ExpectedContents } from './drivers/memory.ts';
import { StorageManager } from './storage.ts';
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

/**
 * The storage of a test app (default in `createTestApp`, like the mail and queue fakes): every configured disk is an
 * in-memory disk with the configured name, visibility and URL — nothing touches the file system or S3, and each test
 * starts empty. Keys are checked as on every disk; `temporaryUrl()` signs real URLs the app's routes serve from memory.
 * Assert with `app.storage.disk('local').assertExists(key)`.
 */
export class StorageFake extends StorageManager {
  constructor(container: Container) {
    const setup = container.make(StorageSetup);
    super(setup.options, setup.dependencies);
  }

  override disk<const N extends DiskNameInput = DefaultDiskName>(name?: CheckDiskName<N>): FakeDisk<N> {
    return super.disk(name) as FakeDisk<N>;
  }

  protected override build(name: string, options: DiskOptions): Disk {
    return this.memory(name, options);
  }
}

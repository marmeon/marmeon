import { TestClock } from '@marmeon/core/testing';
import { vi } from 'vitest';
import type { DiskDriverFactory, DiskOptions } from '../config.ts';
import type { Disk } from '../disk.ts';
import { StorageManager } from '../storage.ts';
import type { StorageDependencies } from '../storage.ts';

/** A `Storage` over `disks`, as the app gets it (its disks are the framework's). `drivers` bring custom ones. */
export function managerOf(disks: Record<string, DiskOptions>, root: string, drivers?: Record<string, DiskDriverFactory>): StorageManager {
  const dependencies: StorageDependencies = {
    root,
    clock: new TestClock(),
    temporaryUrls: { sign: (disk, key) => `/signed/${disk}/${key}` },
    drivers: drivers === undefined ? undefined : new Map(Object.entries(drivers)),
    container: drivers === undefined ? undefined : ({ make: () => undefined } as never),
  };
  return new StorageManager({ default: Object.keys(disks)[0]!, disks }, dependencies);
}

/**
 * A disk `Storage` built whose `open()` is `open`: the identity stays the framework's (`vi.spyOn` replaces the method on the
 * object), so `serveFile()` asks it for ranges, which a hand-made disk never gets.
 */
export function frameworkDisk(open: (...args: unknown[]) => Promise<unknown>): Disk {
  const disk = managerOf({ standin: { driver: 'memory' } }, '/').named('standin');
  vi.spyOn(disk, 'open').mockImplementation(open as never);
  return disk;
}

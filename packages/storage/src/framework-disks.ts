import type { Disk } from './disk.ts';

/**
 * The disks `Storage` built. `serveFile()` asks for a range of these only: a disk of an app's own (or a wrapper around one) may
 * forward `open()`'s options and change the bytes, so the slice it returns is not a slice of the file. Held by identity, so a
 * `Proxy` or a copy of a disk is not in it.
 */
const FRAMEWORK_DISKS = new WeakSet<Disk>();

/** Marks a disk `Storage` built; returns it. */
export function frameworkDisk<D extends Disk>(disk: D): D {
  FRAMEWORK_DISKS.add(disk);
  return disk;
}

/** Whether `Storage` built this very object. */
export function isFrameworkDisk(disk: unknown): boolean {
  return typeof disk === 'object' && disk !== null && FRAMEWORK_DISKS.has(disk as Disk);
}

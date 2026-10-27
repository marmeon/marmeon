import { describe, expect, it } from 'vitest';
import * as storage from './index.ts';

describe('public API', () => {
  it('does not export the built-in disk classes: disks are configured, a driver of your own implements DiskDriver', () => {
    // @ts-expect-error not exported
    expect(storage.LocalDisk).toBeUndefined();
    // @ts-expect-error not exported
    expect(storage.MemoryDisk).toBeUndefined();
    // @ts-expect-error not exported
    expect(storage.S3Disk).toBeUndefined();
  });
});

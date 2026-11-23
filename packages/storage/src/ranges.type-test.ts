// What a disk and a driver say about ranges — checked by `tsc` (pnpm build / typecheck), never run.
import type { Disk, DiskDriver, OpenedFile, OpenOptions, Visibility } from './index.ts';

declare const disk: Disk;
declare const base: Omit<DiskDriver, 'open'>;

// A driver written before ranges, one with options of its own and one that honours a range all implement DiskDriver.
class Old implements DiskDriver {
  readonly name = 'old';
  readonly visibility: Visibility = 'private';
  put = base.put;
  get = base.get;
  text = base.text;
  stream = base.stream;
  open(_key: string): Promise<OpenedFile> {
    throw new Error('type test');
  }
  exists = base.exists;
  delete = base.delete;
  move = base.move;
  copy = base.copy;
  size = base.size;
  mimeType = base.mimeType;
  lastModified = base.lastModified;
  list = base.list;
  url = base.url;
  temporaryUrl = base.temporaryUrl;
}
// A driver written before ranges, whose own second parameter means something else, compiles and is never given a range.
class Flagged extends Old {
  override open(_key: string, _original = false): Promise<OpenedFile> {
    throw new Error('type test');
  }
}
class OwnOptions extends Old {
  override open(_key: string, _options?: { readonly version?: string }): Promise<OpenedFile> {
    throw new Error('type test');
  }
}
class Ranged extends Old {
  readonly acceptsRanges = true;
  override open(_key: string, _options?: OpenOptions): Promise<OpenedFile> {
    throw new Error('type test');
  }
}
class Opted extends Old {
  acceptsRanges = true;
}
class NotOpted extends Old {
  acceptsRanges = false;
}
export const drivers: DiskDriver[] = [new Old(), new Flagged(), new OwnOptions(), new Ranged()];
// One declaration each: in the array above both would drop out of the check as subtypes of Old.
export const opted: DiskDriver = new Opted();
export const notOpted: DiskDriver = new NotOpted();

// The three forms, and the options without a range.
void disk.open('a', { range: { start: 1 } });
void disk.open('a', { range: { start: 1, end: 2 } });
void disk.open('a', { range: { last: 3 } });
void disk.open('a', {});
void disk.open('a', { range: undefined });

// @ts-expect-error — a range is { start, end? } or { last }, not { first }
void disk.open('a', { range: { first: 1 } });
// @ts-expect-error — start and last together
void disk.open('a', { range: { start: 1, last: 2 } });
// @ts-expect-error — end and last together
void disk.open('a', { range: { end: 1, last: 2 } });
// @ts-expect-error — a range holds numbers
void disk.open('a', { range: { start: '1' } });
// @ts-expect-error — an unknown option
void disk.open('a', { ranges: { start: 1 } });

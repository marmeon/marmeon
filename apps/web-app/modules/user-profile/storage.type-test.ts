import { Storage, type PrivateDisk, type PublicDisk } from '@bespokecore/storage';

// Disk names and visibility come from config/storage.ts (StorageTypes) — checked by `pnpm typecheck`, never run.
export function storageTypes(storage: Storage) {
  const open: PublicDisk = storage.disk('public');
  const closed: PrivateDisk = storage.disk('local');
  const fallback: PrivateDisk = storage.disk(); // the default disk, `local`
  open.url('avatars/7.webp');
  void closed.temporaryUrl('exports/7.json', { expiresIn: { minutes: 5 } });
  void fallback;

  // @ts-expect-error — not a disk of this app (did you mean …)
  storage.disk('pubic');
  // @ts-expect-error — not a disk of this app (no near name: the list of disks)
  storage.disk('avatars');
  // @ts-expect-error — a private disk has no public URL: use temporaryUrl()
  closed.url('exports/7.json');
  // @ts-expect-error — the default disk is private too
  storage.disk().url('x.json');
  const name: string = 'local';
  // @ts-expect-error — a name from a string is not known to be a disk
  storage.disk(name);
  // @ts-expect-error — expiresIn is required
  void open.temporaryUrl('a.png', {});
}

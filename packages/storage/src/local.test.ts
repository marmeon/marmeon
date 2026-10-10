import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { freshDirectory, recordingUrls, removeDirectories } from './__fixtures__/disks.ts';
import { LocalDisk } from './drivers/local.ts';
import { InvalidKeyError } from './errors.ts';

afterAll(removeDirectories);

/** A root inside a scratch directory, with a secret next to it (outside the root). */
function setup() {
  const base = freshDirectory();
  const root = join(base, 'root');
  mkdirSync(root);
  writeFileSync(join(base, '.env'), 'APP_KEY=secret');
  mkdirSync(join(base, 'outside'));
  writeFileSync(join(base, 'outside', 'secret.txt'), 'outside');
  const disk = new LocalDisk({ name: 'local', root, visibility: 'private', temporaryUrls: recordingUrls });
  return { base, root, disk };
}

describe('the local disk keeps every access inside its root', () => {
  it('"../../.env", an absolute path, NUL, a backslash — refused, nothing read', async () => {
    const { disk, root } = setup();
    await disk.put('public/avatar.png', 'png');
    for (const key of ['../.env', 'public/../../.env', `${root}/../.env`, '/etc/passwd', '.env\u0000.png', '..\\.env']) {
      await expect(disk.get(key)).rejects.toThrow(InvalidKeyError);
    }
  });

  it('the key check alone: "avatars/../secret.txt" stays inside the root, yet is refused — a prefix is a boundary', async () => {
    const { disk } = setup();
    await disk.put('secret.txt', 'root-level secret');
    // The realpath jail cannot refuse this (it stays inside the root): only the key check does.
    await expect(disk.get('avatars/../secret.txt')).rejects.toThrow('".." segment');
  });

  it('the realpath jail alone: a symlink to a file outside the root — refused for every read', async () => {
    const { disk, root, base } = setup();
    symlinkSync(join(base, '.env'), join(root, 'env-link.txt')); // a valid key; only the jail stops it
    for (const read of [() => disk.get('env-link.txt'), () => disk.open('env-link.txt'), () => disk.size('env-link.txt'), () => disk.exists('env-link.txt'), () => disk.copy('env-link.txt', 'copy.txt'), () => disk.move('env-link.txt', 'moved.txt')]) {
      await expect(read()).rejects.toThrow('leads out of the root');
    }
    expect(existsSync(join(root, 'copy.txt'))).toBe(false);
  });

  it('the realpath jail alone: a symlinked directory leading out — no write through it, no read from it', async () => {
    const { disk, root, base } = setup();
    symlinkSync(join(base, 'outside'), join(root, 'uploads'));
    await expect(disk.put('uploads/evil.txt', 'x')).rejects.toThrow('leads out of the root');
    await expect(disk.put('uploads/new/evil.txt', 'x')).rejects.toThrow('leads out of the root');
    expect(readdirSync(join(base, 'outside'))).toEqual(['secret.txt']); // nothing written outside, no directory created
    await expect(disk.get('uploads/secret.txt')).rejects.toThrow('leads out of the root');
    await expect(disk.delete('uploads/secret.txt')).rejects.toThrow('leads out of the root');
    expect(readFileSync(join(base, 'outside', 'secret.txt'), 'utf8')).toBe('outside');
    expect(await disk.list('', { recursive: true })).toEqual([]); // not listed either
    await expect(disk.list('uploads')).rejects.toThrow('leads out of the root');
  });

  it('a write replaces a symlink at the key — it never writes through it', async () => {
    const { disk, root, base } = setup();
    symlinkSync(join(base, 'outside', 'secret.txt'), join(root, 'note.txt'));
    await disk.put('note.txt', 'mine');
    expect(readFileSync(join(base, 'outside', 'secret.txt'), 'utf8')).toBe('outside');
    expect(await disk.text('note.txt')).toBe('mine');
  });

  it('deleting a symlink inside the root removes the link, not its target', async () => {
    const { disk, root } = setup();
    await disk.put('real.txt', 'real');
    symlinkSync(join(root, 'real.txt'), join(root, 'alias.txt'));
    expect(await disk.text('alias.txt')).toBe('real'); // links inside the root are followed
    expect(await disk.delete('alias.txt')).toBe(true);
    expect(await disk.text('real.txt')).toBe('real');
  });

  it('symlinks inside the root are followed (files and directories), and listed', async () => {
    const { disk, root } = setup();
    await disk.put('archive/2026/a.txt', 'a');
    symlinkSync(join(root, 'archive', '2026'), join(root, 'current'));
    expect(await disk.text('current/a.txt')).toBe('a');
    await disk.put('current/b.txt', 'b');
    expect(await disk.text('archive/2026/b.txt')).toBe('b');
    expect(await disk.list('current')).toEqual(['current/a.txt', 'current/b.txt']);
  });

  it('writes are atomic: a temporary file in the directory, renamed into place — never listed', async () => {
    const { disk, root } = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode('half '));
        await gate;
        controller.enqueue(new TextEncoder().encode('and the rest'));
        controller.close();
      },
    });
    await disk.put('doc.txt', 'old');
    const writing = disk.put('doc.txt', body);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await disk.text('doc.txt')).toBe('old'); // readers see the old file, not half the new one
    expect(readdirSync(root).some((name) => name.startsWith('.marmeon-tmp-'))).toBe(true);
    expect(await disk.list()).toEqual(['doc.txt']);
    release();
    await writing;
    expect(await disk.text('doc.txt')).toBe('half and the rest');
    expect(readdirSync(root)).toEqual(['doc.txt']);
  });

  it('a failed write leaves no temporary file behind', async () => {
    const { disk, root } = setup();
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'));
        controller.error(new Error('client went away'));
      },
    });
    await expect(disk.put('doc.txt', failing)).rejects.toThrow('client went away');
    expect(readdirSync(root)).toEqual([]);
  });

  it('creates its root on first use', async () => {
    const base = freshDirectory();
    const disk = new LocalDisk({ name: 'local', root: join(base, 'deep', 'root'), visibility: 'private', temporaryUrls: recordingUrls });
    await disk.put('a.txt', 'a');
    expect(readFileSync(join(base, 'deep', 'root', 'a.txt'), 'utf8')).toBe('a');
  });
});

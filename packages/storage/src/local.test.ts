import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshDirectory, recordingUrls, removeDirectories } from './__fixtures__/disks.ts';
import { LocalDisk } from './drivers/local.ts';
import { FileNotFoundError, InvalidKeyError } from './errors.ts';

const watch = vi.hoisted(() => ({ handles: [] as unknown[], afterRealpath: undefined as undefined | (() => void), failStatAt: undefined as undefined | number }));

// Every real file operation runs; the mock only records the handles `open` returns and runs a hook once `realpath` answered.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: (async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      vi.spyOn(handle, 'close');
      vi.spyOn(handle, 'read');
      if (watch.failStatAt !== undefined) {
        const failAt = watch.failStatAt;
        const stat = handle.stat.bind(handle);
        let calls = 0;
        watch.failStatAt = undefined;
        handle.stat = ((...a: Parameters<typeof stat>) => (calls++ === failAt ? Promise.reject(new Error('stat failed')) : stat(...a))) as typeof stat;
      }
      watch.handles.push(handle);
      return handle;
    }) as typeof actual.open,
    realpath: (async (...args: Parameters<typeof actual.realpath>) => {
      const real = await actual.realpath(...args);
      const hook = watch.afterRealpath;
      watch.afterRealpath = undefined;
      hook?.();
      return real;
    }) as typeof actual.realpath,
  };
});

beforeEach(() => {
  watch.handles.length = 0;
  watch.afterRealpath = undefined;
  watch.failStatAt = undefined;
});

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

describe('the local disk opens a range of a file inside its root', () => {
  const handles = () => watch.handles as FileHandle[];
  const closed = (handle: FileHandle) => vi.mocked(handle.close).mock.calls.length;
  const reads = (handle: FileHandle) => vi.mocked(handle.read).mock.calls as unknown as [Uint8Array, number, number, number | null][];
  const text = async (stream: ReadableStream<Uint8Array>) => new Response(stream).text();

  it('negative: a symlink out of the root, "..", an absolute path and a missing file are refused with a range, no descriptor is opened', async () => {
    const { disk, root, base } = setup();
    symlinkSync(join(base, '.env'), join(root, 'env-link.txt'));
    symlinkSync(join(base, 'outside'), join(root, 'uploads'));
    for (const range of [{ start: 0 }, { start: 2, end: 4 }, { last: 3 }]) {
      await expect(disk.open('env-link.txt', { range })).rejects.toThrow('leads out of the root');
      await expect(disk.open('uploads/secret.txt', { range })).rejects.toThrow('leads out of the root');
      for (const key of ['../.env', 'public/../../.env', `${root}/../.env`, '/etc/passwd']) {
        await expect(disk.open(key, { range })).rejects.toThrow(InvalidKeyError);
      }
      await expect(disk.open('nothing.txt', { range })).rejects.toThrow(FileNotFoundError);
    }
    expect(handles()).toEqual([]); // no descriptor was ever opened
  });

  it('negative: a file swapped for a symlink after the path was checked is refused with a range, no descriptor is opened', async () => {
    const { disk, root, base } = setup();
    await disk.put('doc.txt', 'inside the root');
    watch.afterRealpath = () => {
      renameSync(join(root, 'doc.txt'), join(root, 'moved.txt'));
      symlinkSync(join(base, '.env'), join(root, 'doc.txt'));
    };
    await expect(disk.open('doc.txt', { range: { start: 0, end: 3 } })).rejects.toThrow('became a symlink while it was opened');
    expect(handles()).toEqual([]); // O_NOFOLLOW refused it: nothing of the secret was opened
  });

  it('negative: a bad range is refused with a RangeError, no descriptor is opened', async () => {
    const { disk } = setup();
    await disk.put('doc.txt', 'abc');
    await expect(disk.open('doc.txt', { range: { start: 2, end: 1 } })).rejects.toThrow(RangeError);
    expect(handles()).toEqual([]);
  });

  it('the descriptor is closed when the body is read to its end, cancelled, or the range is unsatisfiable', async () => {
    const { disk } = setup();
    await disk.put('doc.txt', '0123456789');
    expect(await text((await disk.open('doc.txt', { range: { start: 2, end: 4 } })).body)).toBe('234');
    await (await disk.open('doc.txt', { range: { start: 2 } })).body.cancel();
    const unsatisfiable = await disk.open('doc.txt', { range: { start: 99 } });
    expect(unsatisfiable.range).toBe('unsatisfiable');
    expect(handles()).toHaveLength(3);
    expect(handles().map(closed)).toEqual([1, 1, 1]); // exactly once each, the last one before the body was read
  });

  it('the descriptor is closed when a read fails, when stat() fails, and the error reaches the caller', async () => {
    const { disk } = setup();
    await disk.put('doc.txt', '0123456789');
    const file = await disk.open('doc.txt', { range: { start: 0 } });
    vi.mocked(handles()[0]!.read).mockRejectedValueOnce(new Error('disk error'));
    await expect(text(file.body)).rejects.toThrow('disk error');
    expect(closed(handles()[0]!)).toBe(1);

    // The first stat() is the file check, the second the one of open().
    for (const failAt of [0, 1]) {
      watch.failStatAt = failAt;
      await expect(disk.open('doc.txt', { range: { start: 0 } })).rejects.toThrow('stat failed');
      expect(closed(handles().at(-1)!)).toBe(1);
    }
    expect(handles()).toHaveLength(3);
  });

  it('a short range reads no more of the file than it holds', async () => {
    const { disk } = setup();
    await disk.put('big.bin', new Uint8Array(300_000));
    const file = await disk.open('big.bin', { range: { start: 100_000, end: 100_009 } });
    expect((await new Response(file.body).arrayBuffer()).byteLength).toBe(10);
    const [handle] = handles();
    expect(reads(handle!).map(([, , length, position]) => [length, position])).toEqual([[10, 100_000]]);

    const last = await disk.open('big.bin', { range: { last: 5 } });
    await new Response(last.body).arrayBuffer();
    expect(reads(handles()[1]!).map(([, , length, position]) => [length, position])).toEqual([[5, 299_995]]);
  });

  it('a file that grows after open: the body ends at `end`, not at the new end', async () => {
    const { disk, root } = setup();
    await disk.put('log.txt', '0123456789');
    const file = await disk.open('log.txt', { range: { start: 3, end: 6 } });
    appendFileSync(join(root, 'log.txt'), 'abcdef');
    expect(await text(file.body)).toBe('3456');
    expect(file.size).toBe(10);
    const whole = await disk.open('log.txt', { range: { start: 8 } });
    appendFileSync(join(root, 'log.txt'), 'xyz');
    expect(await text(whole.body)).toBe('89abcdef'); // `end` was the file's last byte when it was opened: no 'xyz'
  });

  it('an empty file with a suffix range: the body is empty although the file grows afterwards, the descriptor closed', async () => {
    const { disk, root } = setup();
    await disk.put('log.txt', '');
    const file = await disk.open('log.txt', { range: { last: 5 } });
    appendFileSync(join(root, 'log.txt'), 'x'.repeat(200_000));
    expect([file.range, await text(file.body)]).toEqual([undefined, '']);
    expect(closed(handles()[0]!)).toBe(1);
  });

  it('a file replaced after open (rename, as put() does): the body keeps the old bytes', async () => {
    const { disk } = setup();
    await disk.put('doc.txt', '0123456789');
    const file = await disk.open('doc.txt', { range: { start: 5 } });
    await disk.put('doc.txt', 'abcdefghijklmnop');
    expect(await text(file.body)).toBe('56789');
  });

  it('a file truncated after open: the body errors instead of ending as if it were complete', async () => {
    const { disk, root } = setup();
    await disk.put('doc.txt', '0123456789');
    const file = await disk.open('doc.txt', { range: { start: 2, end: 9 } });
    truncateSync(join(root, 'doc.txt'), 4);
    await expect(text(file.body)).rejects.toThrow('shorter');
    expect(closed(handles()[0]!)).toBe(1);
  });
});

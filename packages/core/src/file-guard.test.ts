import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { open } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { withFileGuard } from './file-guard.ts';

const WORKER = fileURLToPath(new URL('./__fixtures__/guard-worker.ts', import.meta.url));
const PACKAGE = fileURLToPath(new URL('..', import.meta.url));

describe('withFileGuard — one writer per file, across processes', () => {
  it('eight processes meet a stale guard, round after round: one at a time takes it over — never two inside at once', { timeout: 60_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'marmeon-guard-'));
    try {
      const file = join(dir, 'session');
      const log = join(dir, 'log');
      writeFileSync(log, '');
      const workers = await Promise.all(
        Array.from({ length: 8 }, async () => {
          const child = spawn(process.execPath, ['--conditions=@marmeon/source', WORKER, file, log], { cwd: PACKAGE, stdio: ['pipe', 'pipe', 'inherit'] });
          const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
          expect((await lines.next()).value).toBe('ready');
          return { child, next: () => lines.next() };
        }),
      );
      for (let round = 0; round < 20; round++) {
        // A guard a crashed process left behind: older than the 2 s after which it counts as stale.
        writeFileSync(`${file}.guard`, '');
        const past = new Date(Date.now() - 60_000);
        utimesSync(`${file}.guard`, past, past);
        const at = Date.now() + 40;
        for (const { child } of workers) child.stdin!.write(`go ${at}\n`);
        expect((await Promise.all(workers.map(({ next }) => next()))).map((line) => line.value)).toEqual(Array(8).fill('done'));
      }
      for (const { child } of workers) child.stdin!.end();
      // Entries and exits strictly alternate, each exit the last entry's process: nobody was inside at the same time.
      const entries = readFileSync(log, 'utf8').trim().split('\n');
      expect(entries).toHaveLength(20 * 8 * 2);
      const overlaps = entries.filter((line, at) => (at % 2 === 0 ? !line.startsWith('+') : line !== `-${entries[at - 1]!.slice(1)}`));
      expect(overlaps).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('releases only its own guard and says when the file stays busy', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'marmeon-guard-'));
    try {
      const file = join(dir, 'entry');
      // Taken over while it worked (it was slower than staleMs): its release leaves the new holder's guard alone.
      await withFileGuard(file, async () => {
        rmSync(`${file}.guard`);
        writeFileSync(`${file}.guard`, 'another holder');
      });
      expect(readFileSync(`${file}.guard`, 'utf8')).toBe('another holder');
      rmSync(`${file}.guard`);
      // A new holder that got the same inode (filesystems reuse them at once): overwritten in place, still not ours.
      await withFileGuard(file, async () => {
        writeFileSync(`${file}.guard`, 'same inode');
      });
      expect(readFileSync(`${file}.guard`, 'utf8')).toBe('same inode');
      await expect(withFileGuard(file, async () => 1, { timeoutMs: 50, busy: (seconds) => `busy for ${seconds} s` })).rejects.toThrow('busy for 0.05 s');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves no guard behind when writing its token fails, and never runs the work', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'marmeon-guard-'));
    const probe = await open(join(dir, 'probe'), 'w');
    const writeFile = vi.spyOn(Object.getPrototypeOf(probe), 'writeFile').mockRejectedValueOnce(Object.assign(new Error('no space'), { code: 'ENOSPC' }));
    await probe.close();
    try {
      const file = join(dir, 'entry');
      const work = vi.fn(async () => 1);
      await expect(withFileGuard(file, work)).rejects.toMatchObject({ code: 'ENOSPC' });
      expect(work).not.toHaveBeenCalled();
      expect(existsSync(`${file}.guard`)).toBe(false);
    } finally {
      writeFile.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

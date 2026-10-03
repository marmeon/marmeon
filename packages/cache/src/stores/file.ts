import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { SystemClock, type Clock } from '@bespokecore/core';
import type { CacheStore, Entry } from '../cache.ts';

/** A guard older than this was left by a process that died inside its few-microsecond critical section. */
const STALE_GUARD_MS = 2_000;
/** Longer than this waiting for one key's guard is a bug (or a dead disk), not contention. */
const GUARD_TIMEOUT_MS = 10_000;

const ENTRY = /^[0-9a-f]{64}$/;

/**
 * One JSON file per key (named by its hash) with its expiry inside, written atomically (temporary file + rename).
 * Survives restarts; shared by the processes of one machine.
 *
 * What decides on the stored value — `add`, `increment`, locks — runs under a per-key guard: a `<hash>.guard` file
 * created with `open(…, 'wx')`, which the file system grants to one process at a time. Locks live in `locks/`.
 */
export class FileStore implements CacheStore {
  readonly #directory: string;
  readonly #locks: string;
  readonly #clock: Clock;

  constructor(directory: string, clock: Clock = new SystemClock()) {
    this.#directory = directory;
    this.#locks = join(directory, 'locks');
    this.#clock = clock;
    mkdirSync(this.#locks, { recursive: true });
  }

  async read(key: string): Promise<Entry | undefined> {
    const entry = await this.#readFile(this.#path(key));
    return entry && this.#isAlive(entry) ? entry : undefined;
  }

  async write(key: string, entry: Entry): Promise<void> {
    await this.#writeFile(this.#path(key), entry);
  }

  add(key: string, entry: Entry): Promise<boolean> {
    const file = this.#path(key);
    return this.#guarded(file, async () => {
      const current = await this.#readFile(file);
      if (current && this.#isAlive(current)) return false;
      await this.#writeFile(file, entry);
      return true;
    });
  }

  increment(key: string, by: number, expires: number | null): Promise<number> {
    const file = this.#path(key);
    return this.#guarded(file, async () => {
      const current = await this.#readFile(file);
      const counting = current && this.#isAlive(current) && Number.isSafeInteger(current.value);
      const next: Entry = counting ? { value: (current.value as number) + by, expires: current.expires } : { value: by, expires };
      await this.#writeFile(file, next);
      return next.value as number;
    });
  }

  async delete(key: string): Promise<void> {
    await rm(this.#path(key), { force: true });
  }

  async clear(): Promise<void> {
    // Entries (and temporary files left by a crash) — never the locks, never a guard someone holds right now.
    for (const name of await readdir(this.#directory)) {
      if (ENTRY.test(name) || name.endsWith('.tmp')) await rm(join(this.#directory, name), { force: true });
    }
  }

  lock(name: string, owner: string, expires: number): Promise<boolean> {
    const file = this.#lockPath(name);
    return this.#guarded(file, async () => {
      const current = await this.#readFile(file);
      if (current && this.#isAlive(current) && current.value !== owner) return false;
      await this.#writeFile(file, { value: owner, expires });
      return true;
    });
  }

  unlock(name: string, owner: string): Promise<boolean> {
    const file = this.#lockPath(name);
    return this.#guarded(file, async () => {
      const current = await this.#readFile(file);
      if (!current || !this.#isAlive(current) || current.value !== owner) return false;
      await rm(file, { force: true });
      return true;
    });
  }

  async forceUnlock(name: string): Promise<void> {
    await rm(this.#lockPath(name), { force: true });
  }

  async lockOwner(name: string): Promise<string | undefined> {
    const current = await this.#readFile(this.#lockPath(name));
    return current && this.#isAlive(current) ? (current.value as string) : undefined;
  }

  /**
   * Removes expired entry and lock files, each under its guard (an `add`, `increment` or lock at the same moment waits).
   * A plain `put` that replaces an entry right while it is checked can lose that new value — a cache miss, nothing worse.
   */
  async prune(): Promise<number> {
    let removed = 0;
    for (const [directory, test] of [
      [this.#directory, ENTRY],
      [this.#locks, ENTRY],
    ] as const) {
      for (const name of await readdir(directory)) {
        if (!test.test(name)) continue;
        const file = join(directory, name);
        const gone = await this.#guarded(file, async () => {
          const entry = await this.#readFile(file);
          if (!entry || this.#isAlive(entry)) return false;
          await rm(file, { force: true });
          return true;
        });
        if (gone) removed++;
      }
    }
    return removed;
  }

  #isAlive(entry: Entry): boolean {
    return entry.expires === null || entry.expires > this.#clock.now();
  }

  async #readFile(file: string): Promise<Entry | undefined> {
    try {
      return JSON.parse(await readFile(file, 'utf8')) as Entry;
    } catch {
      return undefined; // absent (or unreadable: counts as absent, the next write replaces it)
    }
  }

  async #writeFile(file: string, entry: Entry): Promise<void> {
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(entry), { mode: 0o600 });
    await rename(temporary, file);
  }

  /** Runs `work` while holding the guard of `file` — one process (and one call) at a time per key. */
  async #guarded<T>(file: string, work: () => Promise<T>): Promise<T> {
    const guard = `${file}.guard`;
    const started = performance.now();
    for (;;) {
      try {
        await (await open(guard, 'wx', 0o600)).close();
        break;
      } catch (error) {
        if ((error as { code?: string }).code !== 'EEXIST') throw error;
      }
      // Held by another: wait a moment — or clear a guard a crashed process left behind.
      const held = await stat(guard).catch(() => undefined);
      if (held && Date.now() - held.mtimeMs > STALE_GUARD_MS) await rm(guard, { force: true });
      else if (performance.now() - started > GUARD_TIMEOUT_MS) throw new Error(`The cache file ${file} stayed busy for ${GUARD_TIMEOUT_MS / 1000} s.`);
      else await sleep(1 + Math.random() * 4);
    }
    try {
      return await work();
    } finally {
      await rm(guard, { force: true });
    }
  }

  #path(key: string): string {
    return join(this.#directory, createHash('sha256').update(key).digest('hex'));
  }

  #lockPath(name: string): string {
    return join(this.#locks, createHash('sha256').update(name).digest('hex'));
  }
}

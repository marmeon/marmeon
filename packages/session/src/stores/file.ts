import { mkdirSync } from 'node:fs';
import { link, open, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { SystemClock, withFileGuard, type Clock } from '@marmeon/core';
import { SESSION_KEY, type SessionStore, type SessionWrite, type SessionWriteResult, type StoredSession } from '../store.ts';

interface Stored {
  expires: number;
  version: number;
  data: string;
}

/** A guard older than this was left by a process that died inside its few-millisecond critical section. */
const STALE_GUARD_MS = 2_000;
/** Longer than this waiting for one session's guard is a bug (or a dead disk), not contention. */
const GUARD_TIMEOUT_MS = 10_000;

/**
 * One file per session, named by the session's key (the SHA-256 of its id). A new key is written to a temporary file and
 * hard-linked into place, so it never replaces a session. Writing back compares the version under a per-session guard
 * (`<key>.guard`, `open(…, 'wx')`, granted to one process at a time) and overwrites through a handle opened before the check:
 * a session deleted before the `open` fails it (ENOENT), one deleted after takes the write with it — nothing brings a destroyed
 * session back, and `destroy` needs no guard. The record is ONE line of JSON: an in-place write never truncates, and a reader
 * that meets a torn line reads again.
 */
export class FileSessionStore implements SessionStore {
  readonly #directory: string;
  readonly #clock: Clock;

  constructor(directory: string, clock: Clock = new SystemClock()) {
    this.#directory = directory;
    this.#clock = clock;
    mkdirSync(directory, { recursive: true });
  }

  async read(key: string): Promise<StoredSession | undefined> {
    const file = this.#path(key);
    for (let attempt = 0; ; attempt++) {
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch {
        return undefined; // missing: a new session starts
      }
      const stored = parse(text);
      if (stored) return stored.expires > this.#clock.now() ? { data: stored.data, version: stored.version } : undefined;
      // Torn by a write in progress — or broken for good, then a new session starts.
      if (attempt === 3) return undefined;
      await sleep(2 ** attempt);
    }
  }

  async write(key: string, data: string, { expectedVersion, lifetimeSeconds }: SessionWrite): Promise<SessionWriteResult> {
    const file = this.#path(key);
    if (expectedVersion === undefined) return this.#create(file, data, lifetimeSeconds);
    return this.#guarded(file, async () => {
      let handle;
      try {
        handle = await open(file, 'r+');
      } catch (error) {
        if ((error as { code?: unknown }).code === 'ENOENT') return 'gone'; // destroyed meanwhile
        throw error;
      }
      try {
        const current = parse(await handle.readFile('utf8'));
        if (!current || current.expires <= this.#clock.now()) return 'gone'; // expired (or broken): not brought back
        if (current.version !== expectedVersion) return 'conflict';
        await handle.write(this.#record(data, current.version + 1, lifetimeSeconds), 0, 'utf8');
        const now = new Date(this.#clock.now());
        await handle.utimes(now, now); // the last activity, on the store's clock — what `gc` goes by
        return 'written';
      } finally {
        await handle.close();
      }
    });
  }

  async destroy(key: string): Promise<void> {
    await rm(this.#path(key), { force: true });
  }

  /** By modification time (the last write, on the store's clock), like Laravel's file handler: no file is read. */
  async gc(lifetimeSeconds: number): Promise<number> {
    let removed = 0;
    for (const name of await readdir(this.#directory)) {
      if (name.endsWith('.guard') || name.endsWith('.guard.break')) continue; // held right now — or left by a crash, cleared by the next writer
      const file = join(this.#directory, name);
      try {
        if ((await stat(file)).mtimeMs + lifetimeSeconds * 1000 < this.#clock.now()) {
          await rm(file, { force: true });
          removed++;
        }
      } catch {
        // Removed concurrently.
      }
    }
    return removed;
  }

  /** A new key: written whole to a temporary file, then linked into place — never over an existing session. */
  async #create(file: string, data: string, lifetimeSeconds: number): Promise<SessionWriteResult> {
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, this.#record(data, 1, lifetimeSeconds), { mode: 0o600 });
    try {
      const now = new Date(this.#clock.now());
      await utimes(temporary, now, now);
      await link(temporary, file);
      return 'written';
    } catch (error) {
      if ((error as { code?: unknown }).code === 'EEXIST') return 'conflict';
      throw error;
    } finally {
      await rm(temporary, { force: true });
    }
  }

  /** Runs `work` while holding the guard of `file` — one writer (process or call) at a time per session. */
  async #guarded<T>(file: string, work: () => Promise<T>): Promise<T> {
    return withFileGuard(file, work, { staleMs: STALE_GUARD_MS, timeoutMs: GUARD_TIMEOUT_MS, busy: (seconds) => `The session file ${file} stayed busy for ${seconds} s.` });
  }


  #record(data: string, version: number, lifetimeSeconds: number): string {
    // JSON.stringify never writes a raw line break: the record is exactly the first line.
    return `${JSON.stringify({ expires: this.#clock.now() + lifetimeSeconds * 1000, version, data } satisfies Stored)}\n`;
  }

  #path(key: string): string {
    if (!SESSION_KEY.test(key)) throw new Error(`Invalid session key "${key}".`);
    return join(this.#directory, key);
  }
}

/** The record in the first line — undefined when it is torn or broken. */
function parse(text: string): Stored | undefined {
  const end = text.indexOf('\n');
  try {
    const stored = JSON.parse(end === -1 ? text : text.slice(0, end)) as Stored;
    return typeof stored?.expires === 'number' && typeof stored.version === 'number' && typeof stored.data === 'string' ? stored : undefined;
  } catch {
    return undefined;
  }
}

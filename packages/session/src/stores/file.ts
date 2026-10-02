import { mkdirSync } from 'node:fs';
import { open, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { SystemClock, type Clock } from '@bespokecore/core';
import { SESSION_ID, type SessionPayload, type SessionStore } from '../store.ts';

interface Stored {
  expires: number;
  data: SessionPayload;
}

/**
 * One file per session (Laravel's default). Survives restarts.
 *
 * - **New ids** (`write`) go to a temporary file renamed into place — a reader sees all of a session or none.
 * - **Writing back** (`writeIfExists`) opens the existing file (`r+`) and overwrites it in place: a session deleted
 *   meanwhile fails the `open` (ENOENT) — or, deleted after it, takes the write with it (the open handle writes to the
 *   unlinked file). Nothing ever brings a destroyed session back, without a lock.
 *
 * The record is ONE line of JSON; what follows the first line break is ignored. An in-place write never truncates, so
 * writes racing each other leave one whole record in front (the file keeps its largest size until the id changes), and
 * a reader that meets a write in progress (a torn line) reads again.
 */
export class FileSessionStore implements SessionStore {
  readonly #directory: string;
  readonly #clock: Clock;

  constructor(directory: string, clock: Clock = new SystemClock()) {
    this.#directory = directory;
    this.#clock = clock;
    mkdirSync(directory, { recursive: true });
  }

  async read(id: string): Promise<SessionPayload | undefined> {
    const file = this.#path(id);
    for (let attempt = 0; ; attempt++) {
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch {
        return undefined; // missing: a new session starts
      }
      const stored = parse(text);
      if (stored) return stored.expires > this.#clock.now() ? stored.data : undefined;
      // Torn by a write in progress — or broken for good, then a new session starts.
      if (attempt === 3) return undefined;
      await sleep(2 ** attempt);
    }
  }

  async write(id: string, data: SessionPayload, lifetimeSeconds: number): Promise<void> {
    const file = this.#path(id);
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, this.#record(data, lifetimeSeconds), { mode: 0o600 });
    const now = new Date(this.#clock.now());
    await utimes(temporary, now, now); // the last activity, on the store's clock — what `gc` goes by
    await rename(temporary, file);
  }

  async writeIfExists(id: string, data: SessionPayload, lifetimeSeconds: number): Promise<boolean> {
    let handle;
    try {
      handle = await open(this.#path(id), 'r+');
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ENOENT') return false; // destroyed meanwhile
      throw error;
    }
    try {
      const current = parse(await handle.readFile('utf8'));
      if (current && current.expires <= this.#clock.now()) return false; // expired: not brought back
      await handle.write(this.#record(data, lifetimeSeconds), 0, 'utf8');
      const now = new Date(this.#clock.now());
      await handle.utimes(now, now);
      return true;
    } finally {
      await handle.close();
    }
  }

  async destroy(id: string): Promise<void> {
    await rm(this.#path(id), { force: true });
  }

  /** By modification time (the last write, on the store's clock), like Laravel's file handler: no file is read. */
  async gc(lifetimeSeconds: number): Promise<number> {
    let removed = 0;
    for (const name of await readdir(this.#directory)) {
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

  #record(data: SessionPayload, lifetimeSeconds: number): string {
    // JSON.stringify never writes a raw line break: the record is exactly the first line.
    return `${JSON.stringify({ expires: this.#clock.now() + lifetimeSeconds * 1000, data } satisfies Stored)}\n`;
  }

  #path(id: string): string {
    if (!SESSION_ID.test(id)) throw new Error(`Invalid session id "${id}".`);
    return join(this.#directory, id);
  }
}

/** The record in the first line — undefined when it is torn or broken. */
function parse(text: string): Stored | undefined {
  const end = text.indexOf('\n');
  try {
    const stored = JSON.parse(end === -1 ? text : text.slice(0, end)) as Stored;
    return typeof stored?.expires === 'number' ? stored : undefined;
  } catch {
    return undefined;
  }
}

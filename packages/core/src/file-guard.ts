import { open, rm, stat } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

export interface FileGuardOptions {
  /** A guard older than this (ms) was left by a process that died inside its critical section — it is taken over. */
  readonly staleMs?: number;
  /** Waiting longer than this (ms) is a bug or a dead disk, not contention: the error says `busy`. */
  readonly timeoutMs?: number;
  /** What the timeout's error says: `The session file … stayed busy for 10 s.` */
  readonly busy?: (seconds: number) => string;
}

/**
 * Runs `work` while holding `<file>.guard` — one writer at a time per file, across processes (the file stores of the session
 * and the cache). The guard is a file created exclusively (`wx`); a holder removes only its own (by inode). A guard older than
 * `staleMs` is broken by one waiter at a time, and only while it is still the file found stale (same inode) — removing it by
 * name would let two waiters that both saw it stale delete each other's fresh guards: two writers at once.
 */
export async function withFileGuard<T>(file: string, work: () => Promise<T>, { staleMs = 2_000, timeoutMs = 10_000, busy }: FileGuardOptions = {}): Promise<T> {
  const guard = `${file}.guard`;
  const started = performance.now();
  let own: { dev: number; ino: number };
  for (;;) {
    try {
      const handle = await open(guard, 'wx', 0o600);
      try {
        const { dev, ino } = await handle.stat();
        own = { dev, ino };
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error;
    }
    // Held by another: wait a moment — or take over a guard a crashed process left behind.
    const held = await stat(guard).catch(() => undefined);
    if (held && Date.now() - held.mtimeMs > staleMs) await takeOver(guard, held, staleMs);
    else if (performance.now() - started > timeoutMs) throw new Error(busy?.(timeoutMs / 1000) ?? `The file ${file} stayed busy for ${timeoutMs / 1000} s.`);
    else await sleep(1 + Math.random() * 4);
  }
  try {
    return await work();
  } finally {
    // Only our own guard: one taken over meanwhile (we were slower than `staleMs`) belongs to its new holder.
    const current = await stat(guard).catch(() => undefined);
    if (current && current.dev === own.dev && current.ino === own.ino) await rm(guard, { force: true });
  }
}

/**
 * Removes the stale guard `seen` — and only it. Breaking a stale guard is itself guarded (`<guard>.break`, exclusive): its holder
 * looks again and removes the guard only while it is still the very file found stale (same inode, still old) — a fresh guard
 * is never stale, so no waiter can remove another's. A break guard left by a crash goes after `staleMs` too.
 */
async function takeOver(guard: string, seen: { dev: number; ino: number }, staleMs: number): Promise<void> {
  const breaker = `${guard}.break`;
  try {
    await (await open(breaker, 'wx', 0o600)).close();
  } catch (error) {
    if ((error as { code?: string }).code !== 'EEXIST') throw error;
    const held = await stat(breaker).catch(() => undefined);
    if (held && Date.now() - held.mtimeMs > staleMs) await rm(breaker, { force: true });
    return; // another waiter breaks it — try again in a moment
  }
  try {
    const now = await stat(guard).catch(() => undefined);
    if (now && now.dev === seen.dev && now.ino === seen.ino && Date.now() - now.mtimeMs > staleMs) await rm(guard, { force: true });
  } finally {
    await rm(breaker, { force: true });
  }
}

import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { freshTarget, type StoreKind, storeKinds, type StoreTarget } from '../__fixtures__/stores.ts';

const CONTENDER = fileURLToPath(new URL('../__fixtures__/contender.ts', import.meta.url));
const PACKAGE = fileURLToPath(new URL('../..', import.meta.url));

/** Starts a contender process and waits until it has its store open. */
async function contender(target: StoreTarget, operation: 'hit' | 'add', count: number, key: string) {
  const child = spawn(process.execPath, ['--conditions=@marmeon/source', CONTENDER, JSON.stringify(target), operation, String(count), key], {
    cwd: PACKAGE,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
  const ready = await lines.next();
  if (ready.value !== 'ready') throw new Error(`The contender did not start: ${String(ready.value)}`);
  return {
    child,
    result: async (): Promise<number> => {
      const line = await lines.next();
      await exited(child);
      return Number(line.value);
    },
  };
}

async function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode === null) await once(child, 'exit');
}

/** Two processes fire `count` operations each at the same moment against one store; the successes of both. */
async function race(target: StoreTarget, operation: 'hit' | 'add', count: number): Promise<number[]> {
  const key = `${operation}:${crypto.randomUUID()}`;
  const contenders = await Promise.all([contender(target, operation, count, key), contender(target, operation, count, key)]);
  for (const { child } of contenders) child.stdin!.end('go\n');
  return Promise.all(contenders.map(({ result }) => result()));
}

// The Gegenproben of E103 across processes: what a single process cannot show — two Node processes on one store.
// (The memory store is one process by nature: its 100 concurrent attempts are in stores.test.ts.)
describe.each(storeKinds.filter((kind): kind is Exclude<StoreKind, 'memory'> => kind !== 'memory'))('the %s store, from two processes', (kind) => {
  it('lets exactly 10 of 2 × 100 concurrent attempts through a limit of 10', { timeout: 30_000 }, async () => {
    const { target, drop } = await freshTarget(kind);
    try {
      const allowed = await race(target, 'hit', 100);
      expect(allowed[0]! + allowed[1]!).toBe(10);
    } finally {
      await drop();
    }
  });

  it('lets exactly one of 2 × 50 concurrent adds win', { timeout: 30_000 }, async () => {
    const { target, drop } = await freshTarget(kind);
    try {
      const added = await race(target, 'add', 50);
      expect(added[0]! + added[1]!).toBe(1);
    } finally {
      await drop();
    }
  });
});

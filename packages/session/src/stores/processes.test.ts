import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { SystemClock } from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import { plainSessionCodec } from '../codec.ts';
import type { SessionConfig } from '../config.ts';
import { Session } from '../session.ts';
import { sessionKey, SESSION_USER_KEY } from '../store.ts';
import { freshTarget, LIFETIME, openStore, type StoreKind, storeKinds, type StoreTarget } from '../__fixtures__/stores.ts';

const FLASHER = fileURLToPath(new URL('../__fixtures__/flasher.ts', import.meta.url));
const PACKAGE = fileURLToPath(new URL('../..', import.meta.url));

/** Starts a flashing process and waits until it has its store open. */
async function flasher(target: StoreTarget, id: string, count: number, prefix: string) {
  const child = spawn(process.execPath, ['--conditions=@marmeon/source', FLASHER, JSON.stringify(target), id, String(count), prefix], {
    cwd: PACKAGE,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
  const ready = await lines.next();
  if (ready.value !== 'ready') throw new Error(`The flasher did not start: ${String(ready.value)}`);
  return {
    child,
    result: async (): Promise<number> => {
      const line = await lines.next();
      if (child.exitCode === null) await once(child as ChildProcess, 'exit');
      return Number(line.value);
    },
  };
}

// 4 Node processes × 5 requests of one session, all flashing at once — every message arrives, none is lost to a later
// writer's copy. (Memory is one process by nature: its 20 writers are in stores.test.ts.)
describe.each(storeKinds.filter((kind): kind is Exclude<StoreKind, 'memory'> => kind !== 'memory'))('the %s session store, from four processes', (kind) => {
  it('20 requests of one session flash at once — all 20 messages arrive', { timeout: 60_000 }, async () => {
    const { target, drop } = await freshTarget(kind);
    try {
      const { store, close } = openStore(target, new SystemClock());
      const config = { lifetimeMinutes: LIFETIME / 60 } as SessionConfig;
      const signedIn = new Session(store, config, plainSessionCodec);
      await signedIn.start(undefined);
      signedIn.put(SESSION_USER_KEY, '7');
      await signedIn.save();

      const flashers = await Promise.all(['a', 'b', 'c', 'd'].map((prefix) => flasher(target, signedIn.id, 5, prefix)));
      for (const { child } of flashers) child.stdin!.end('go\n');
      expect(await Promise.all(flashers.map(({ result }) => result()))).toEqual([5, 5, 5, 5]);

      const stored = JSON.parse((await store.read(sessionKey(signedIn.id)))!.data) as { _flash_messages: { id: string }[]; [SESSION_USER_KEY]: string };
      expect(stored[SESSION_USER_KEY]).toBe('7');
      expect(stored._flash_messages.map((message) => message.id).toSorted()).toEqual(['a', 'b', 'c', 'd'].flatMap((prefix) => [0, 1, 2, 3, 4].map((n) => `${prefix}-${n}`)).toSorted());
      await close();
    } finally {
      await drop();
    }
  });
});

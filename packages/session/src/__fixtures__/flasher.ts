// One of several processes flashing into ONE session at the same moment (`processes.test.ts`, E145). Opens the store named by
// argv[2] (a JSON StoreTarget), says "ready", waits for "go" on stdin, then runs argv[4] requests of the session argv[3] at
// once — each queues the flash message `<argv[5]>-<n>` and saves — and prints how many saves landed. Run with
// `node --conditions=@marmeon/source`.
import { createInterface } from 'node:readline';
import { SystemClock } from '@marmeon/core';
import { plainSessionCodec } from '../codec.ts';
import type { SessionConfig } from '../config.ts';
import { Session } from '../session.ts';
import { sessionKey } from '../store.ts';
import { LIFETIME, openStore, type StoreTarget } from './stores.ts';

const [targetJson, id, countText, prefix] = process.argv.slice(2);
const { store, close } = openStore(JSON.parse(targetJson!) as StoreTarget, new SystemClock());
const config = { lifetime: LIFETIME / 60 } as SessionConfig;

// Warm up (connection, client import), so the race starts with everything open.
await store.read(sessionKey(id!));
process.stdout.write('ready\n');
for await (const line of createInterface({ input: process.stdin })) if (line === 'go') break;

const saved = await Promise.all(
  Array.from({ length: Number(countText) }, async (_, n) => {
    const session = new Session(store, config, plainSessionCodec);
    await session.start(id);
    session.queueFlash({ id: `${prefix}-${n}`, key: 'toast', data: { n } });
    return session.save();
  }),
);
process.stdout.write(`${saved.filter(Boolean).length}\n`);
await close();

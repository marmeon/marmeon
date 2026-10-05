/**
 * One process of the file-guard race (file-guard.test.ts): `ready`, then per `go <ms>` line (from that moment) one guarded section on `<file>` — it notes
 * its entry and exit in `<log>` (a short wait between) — then `done`.
 */
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { withFileGuard } from '../file-guard.ts';

const [file, log] = process.argv.slice(2) as [string, string];
process.stdout.write('ready\n');
for await (const line of createInterface({ input: process.stdin })) {
  // `go <ms>`: all processes start at that moment — together, as waiters meet a stale guard after a crash.
  const [word, at] = line.split(' ');
  if (word !== 'go') break;
  while (Date.now() < Number(at)) await sleep(Math.max(0, Math.min(5, Number(at) - Date.now())));
  await withFileGuard(file, async () => {
    appendFileSync(log, `+${process.pid}\n`);
    await sleep(15);
    appendFileSync(log, `-${process.pid}\n`);
  });
  process.stdout.write('done\n');
}

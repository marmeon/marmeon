/**
 * `pnpm bench fanout` — what one live hint costs the process that holds the streams (W9 step 4: the channel index). In-process:
 * a `LiveHub` with the memory backend and N open streams, each following a channel of its own and one channel they all share;
 * every stream's `hello` read, then hints:
 *
 *   - one follower — a hint on a channel only one stream follows (the common case: `users.<id>`): with the index, independent of N;
 *   - all followers — a hint on the channel every stream follows: O(N) by nature (each stream gets its event).
 *
 *   pnpm bench fanout                         # 50 000 streams
 *   pnpm bench fanout --streams 10000 --runs 15
 *   pnpm bench fanout --live <dir>            # another checkout's packages/live/dist (a base built there) — the numbers before
 *
 * "enqueue" is the refresh until the hub handed the hint to every follower (the backend delivers synchronously in memory); "read"
 * until every follower's reader got it. Medians. Never a gate.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

interface Result {
  readonly streams: number;
  readonly heapPerStreamKB: number;
  readonly oneFollowerMs: number;
  readonly allFollowersEnqueueMs: number;
  readonly allFollowersReadMs: number;
}

export async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { streams: { type: 'string', default: '50000' }, runs: { type: 'string', default: '9' }, live: { type: 'string' }, run: { type: 'boolean' } } });
  const streams = Number(values.streams);
  const runs = Number(values.runs);
  if (!Number.isInteger(streams) || streams < 1 || !Number.isInteger(runs) || runs < 1) {
    process.stderr.write('--streams and --runs expect whole numbers from 1.\n');
    return 2;
  }
  // The measurement runs in a process of its own: the framework's sources (or a base's dist), a heap that is only this.
  if (!values.run) {
    const child = spawn(process.execPath, ['--expose-gc', '--conditions=@bespokecore/source', import.meta.filename, '--run', ...argv], { stdio: ['ignore', 'inherit', 'inherit'] });
    const [code] = (await once(child, 'exit')) as [number | null];
    return code ?? 1;
  }
  const result = await measure(streams, runs, values.live);
  process.stdout.write(
    `${values.live ?? 'packages/live (sources)'} — ${result.streams} streams, ${result.heapPerStreamKB} KB heap each\n` +
      `  one follower:  ${result.oneFollowerMs} ms per hint (median of ${runs})\n` +
      `  all followers: ${result.allFollowersEnqueueMs} ms enqueued, ${result.allFollowersReadMs} ms until every stream read it (median of ${Math.min(runs, 3)})\n`,
  );
  return 0;
}

async function measure(count: number, runs: number, live: string | undefined): Promise<Result> {
  const module = (await import(live ? pathToFileURL(resolve(live, 'packages/live/dist/index.js')).href : '../../packages/live/src/index.ts')) as typeof import('../../packages/live/src/index.ts');
  const logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => logger };
  const backend = new module.MemoryLiveBackend();
  const hub = new module.LiveHub(backend, { heartbeat: 300, retry: 3000, maxStreams: count + 1 }, logger);
  const gc = (globalThis as { gc?: () => void }).gc;
  gc?.();
  const before = process.memoryUsage().heapUsed;
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  for (let n = 0; n < count; n++) {
    const response = await hub.open({ channels: ['shared', `own.${n}`], scope: `scope-${n}`, connection: `tab${String(n).padStart(9, '0')}` });
    const reader = response.body!.getReader();
    await reader.read(); // hello
    readers.push(reader);
  }
  gc?.();
  const heapPerStreamKB = Number(((process.memoryUsage().heapUsed - before) / count / 1024).toFixed(2));
  const one: number[] = [];
  for (let run = 0; run < runs; run++) {
    const started = performance.now();
    await backend.refresh(`own.${run % count}`, ['profile'], undefined);
    one.push(performance.now() - started);
    await readers[run % count]!.read();
  }
  const enqueued: number[] = [];
  const read: number[] = [];
  for (let run = 0; run < Math.min(runs, 3); run++) {
    const started = performance.now();
    await backend.refresh('shared', ['profile'], undefined);
    enqueued.push(performance.now() - started);
    await Promise.all(readers.map((reader) => reader.read()));
    read.push(performance.now() - started);
  }
  await hub.close();
  return {
    streams: count,
    heapPerStreamKB,
    oneFollowerMs: Number(median(one).toFixed(3)),
    allFollowersEnqueueMs: Number(median(enqueued).toFixed(1)),
    allFollowersReadMs: Number(median(read).toFixed(1)),
  };
}

function median(values: number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

if (process.argv.includes('--run') && import.meta.filename === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
  process.exit();
}

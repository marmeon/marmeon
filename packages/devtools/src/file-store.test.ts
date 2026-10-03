import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { EntryIds, type AnyEntry } from './entry.ts';
import { FileStore } from './file-store.ts';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function directory(): string {
  const root = mkdtempSync(join(tmpdir(), 'bespoke-devtools-store-'));
  roots.push(root);
  return join(root, 'storage', 'framework', 'devtools');
}

const ids = new EntryIds();

function log(message: string, at = Date.now(), fields: Partial<AnyEntry> = {}): AnyEntry {
  return { id: ids.next(at), type: 'log', at, batch: 'b1', tags: ['level:info'], content: { level: 'info', message, context: {} }, ...fields } as AnyEntry;
}

function diskBytes(path: string): number {
  return readdirSync(path).reduce((sum, name) => sum + statSync(join(path, name)).size, 0);
}

describe('FileStore (E116)', () => {
  it('writes NDJSON — one file per process and hour — and reads it back: newest first, by type, batch, request, tag, text and page', async () => {
    const path = directory();
    const store = new FileStore({ directory: path });
    const now = Date.now();
    await store.write([log('one', now - 3000), log('two', now - 2000, { batch: 'b2', requestId: 'r-2', tags: ['level:warn'] } as Partial<AnyEntry>)]);
    await store.write([log('three', now - 1000, { jobId: 'j-3' } as Partial<AnyEntry>)]);
    const files = readdirSync(path);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(new RegExp(`^\\d{10}-${process.pid}-[0-9a-f]{6}-0001\\.ndjson$`));
    expect(readFileSync(join(path, files[0]!), 'utf8').trim().split('\n').map((line) => (JSON.parse(line) as AnyEntry).content)).toHaveLength(3);

    const messages = (entries: AnyEntry[]) => entries.map((entry) => (entry.type === 'log' ? entry.content.message : entry.type));
    expect(messages(await store.list())).toEqual(['three', 'two', 'one']);
    expect(messages(await store.list({ batch: 'b2' }))).toEqual(['two']);
    expect(messages(await store.list({ requestId: 'r-2' }))).toEqual(['two']);
    expect(messages(await store.list({ jobId: 'j-3' }))).toEqual(['three']);
    expect(messages(await store.list({ tag: 'level:warn' }))).toEqual(['two']);
    expect(messages(await store.list({ search: 'THR' }))).toEqual(['three']);
    expect(messages(await store.list({ type: 'request' }))).toEqual([]);
    const [newest] = await store.list({ limit: 1 });
    expect(messages(await store.list({ before: newest!.id, limit: 1 }))).toEqual(['two']);
    expect(await store.get(newest!.id)).toEqual(newest);
    expect(await store.usage()).toMatchObject({ files: 1, entries: 3 });
  });

  it('tails what any process appended — a second store reading the same directory sees the first one’s entries', async () => {
    const path = directory();
    const writer = new FileStore({ directory: path });
    const reader = new FileStore({ directory: path });
    const { cursor } = await reader.since();
    await writer.write([log('a'), log('b')]);
    const first = await reader.since(cursor);
    expect(first.entries.map((entry) => (entry.type === 'log' ? entry.content.message : ''))).toEqual(['a', 'b']);
    expect((await reader.since(first.cursor)).entries).toEqual([]);
    await writer.write([log('c')]);
    expect((await reader.since(first.cursor)).entries.map((entry) => (entry.type === 'log' ? entry.content.message : ''))).toEqual(['c']);
  });

  it('reads whole lines only — a line another process is still writing comes with the next read', async () => {
    const path = directory();
    mkdirSync(path, { recursive: true });
    const file = join(path, '2026100412-1-abcdef-0001.ndjson');
    const entry = JSON.stringify(log('half'));
    writeFileSync(file, `${JSON.stringify(log('whole'))}\n${entry.slice(0, 20)}`);
    const store = new FileStore({ directory: path, now: () => Date.now() });
    expect((await store.list()).map((e) => (e.type === 'log' ? e.content.message : ''))).toEqual(['whole']);
    appendFileSync(file, `${entry.slice(20)}\n`);
    expect((await store.list()).map((e) => (e.type === 'log' ? e.content.message : ''))).toEqual(['whole', 'half']);
    expect(store.corrupt).toBe(0);
  });

  it('keeps the ring within maxBytes — after writing twice as much', async () => {
    const path = directory();
    const maxBytes = 256 * 1024;
    const store = new FileStore({ directory: path, maxBytes });
    const filler = 'z'.repeat(900);
    let written = 0;
    let batch = 0;
    while (written < 2 * maxBytes) {
      const entries = Array.from({ length: 10 }, (_, i) => log(`${batch}-${i} ${filler}`));
      written += Buffer.byteLength(entries.map((entry) => JSON.stringify(entry)).join('\n'));
      await store.write(entries);
      batch++;
    }
    expect(diskBytes(path)).toBeLessThanOrEqual(maxBytes);
    // The newest stay.
    const [newest] = await store.list({ limit: 1 });
    expect(newest?.type === 'log' && newest.content.message.startsWith(`${batch - 1}-`)).toBe(true);
  });

  it('forgets what is older than maxAgeHours — not read, and its files pruned', async () => {
    const path = directory();
    let now = Date.now();
    const store = new FileStore({ directory: path, maxAgeHours: 1, now: () => now });
    await store.write([log('old', now)]);
    now += 2 * 3_600_000;
    await store.write([log('new', now)]);
    expect((await store.list()).map((e) => (e.type === 'log' ? e.content.message : ''))).toEqual(['new']);
    // A new hour: the write pruned the old file.
    expect(readdirSync(path)).toHaveLength(1);
    expect(await store.prune()).toEqual({ files: 0, bytes: 0 });
  });

  it('clears everything — also what another process wrote', async () => {
    const path = directory();
    const one = new FileStore({ directory: path });
    const two = new FileStore({ directory: path });
    await one.write([log('a')]);
    await two.write([log('b')]);
    expect(await one.list()).toHaveLength(2);
    await one.clear();
    expect(await one.list()).toEqual([]);
    expect(await two.list()).toEqual([]);
    await one.write([log('c')]);
    expect((await two.list()).map((e) => (e.type === 'log' ? e.content.message : ''))).toEqual(['c']);
  });

  it('never throws on a failed write — it reports it and goes on', async () => {
    const root = directory();
    mkdirSync(join(root, '..'), { recursive: true });
    writeFileSync(root, 'a file where the directory should be');
    const failures: string[] = [];
    const store = new FileStore({ directory: root, onError: (error, during) => failures.push(`${during}: ${(error as { code?: string }).code}`) });
    await expect(store.write([log('lost')])).resolves.toBeUndefined();
    expect(failures).toEqual([expect.stringMatching(/^write: E(EXIST|NOTDIR)$/)]);
    await expect(store.list()).resolves.toEqual([]);
  });

  it('two processes writing at once: no broken line, nothing lost', { timeout: 30_000 }, async () => {
    const path = directory();
    const source = new URL('./file-store.ts', import.meta.url).href;
    const script = `
      const { FileStore } = await import(${JSON.stringify(source)});
      const store = new FileStore({ directory: ${JSON.stringify(path)} });
      const name = process.argv[1];
      // Batches of 1.2 MB (a request with many queries): appends to one shared file would interleave at that size.
      const filler = 'q'.repeat(60_000);
      for (let batch = 0; batch < 15; batch++) {
        const entries = Array.from({ length: 20 }, (_, i) => ({ id: name + '-' + batch + '-' + i, type: 'log', at: Date.now(), batch: name + batch, tags: [], content: { level: 'info', message: filler, context: {} } }));
        store.write(entries);
      }
      await store.write([]);
    `;
    const run = (name: string) =>
      new Promise<number>((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script, name], { stdio: ['ignore', 'inherit', 'inherit'] });
        child.on('error', reject);
        child.on('exit', (code) => resolve(code ?? 1));
      });
    const reader = new FileStore({ directory: path });
    let reading = true;
    const reads = (async () => {
      while (reading) {
        await reader.list({ limit: 5 });
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    })();
    const codes = await Promise.all([run('p1'), run('p2')]);
    reading = false;
    await reads;
    expect(codes).toEqual([0, 0]);
    expect(reader.corrupt).toBe(0);
    for (const name of readdirSync(path)) {
      for (const line of readFileSync(join(path, name), 'utf8').trim().split('\n')) expect(() => JSON.parse(line)).not.toThrow();
    }
    expect((await reader.usage()).entries).toBe(2 * 15 * 20);
  });
});

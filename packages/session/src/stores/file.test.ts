import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { withFileGuard } from '@marmeon/core/internal';
import { TestClock } from '@marmeon/core/testing';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../../scripts/test/temp-dir.js';
import { plainSessionCodec } from '../codec.ts';
import type { SessionConfig } from '../config.ts';
import { Session } from '../session.ts';
import { sessionKey, type SessionStore, type SessionWrite } from '../store.ts';
import { FileSessionStore } from './file.ts';

const NEW = { expectedVersion: undefined, lifetimeSeconds: 60 } satisfies SessionWrite;
const over = (version: number): SessionWrite => ({ expectedVersion: version, lifetimeSeconds: 60 });
const KEY = sessionKey('a'.repeat(43));
const config = { lifetime: 1 } as SessionConfig;

/**
 * A writer in the middle of its in-place write: it holds the guard and leaves `torn` in the file, then finishes with `whole`
 * after `ms` and lets go. Resolves once the torn state is in place; `done` once the writer has finished. (A real in-place
 * write tears for microseconds and not on every filesystem, so the tests stage it.)
 */
async function tearing(file: string, torn: string, whole: string, ms = 50): Promise<{ done: Promise<void> }> {
  let inPlace!: () => void;
  const ready = new Promise<void>((resolve) => (inPlace = resolve));
  const done = withFileGuard(file, async () => {
    await writeFile(file, torn);
    inPlace();
    await sleep(ms);
    await writeFile(file, whole);
  });
  await ready;
  return { done };
}

/** A store holding `data` at version 1; the bytes of that record and of the record a write of `next` leaves in its place. */
async function records(data: string, next: string): Promise<{ store: FileSessionStore; file: string; old: string; whole: string }> {
  const clock = new TestClock();
  const scratch = tempDir('marmeon-session-file-');
  const scratchStore = new FileSessionStore(scratch, clock);
  await scratchStore.write(KEY, data, NEW);
  const old = await readFile(join(scratch, KEY), 'utf8');
  await scratchStore.write(KEY, next, over(1));
  const whole = await readFile(join(scratch, KEY), 'utf8');

  const directory = tempDir('marmeon-session-file-');
  const store = new FileSessionStore(directory, clock);
  await store.write(KEY, data, NEW);
  return { store, file: join(directory, KEY), old, whole };
}

describe('the file session store meets a write in progress', () => {
  it('waits for a half-written record instead of treating the session as unknown', async () => {
    const { store, file, whole } = await records('{"a":1}', '{"a":2,"b":3}');
    const writer = await tearing(file, whole.slice(0, whole.length >> 1), whole);
    expect(await store.read(KEY)).toEqual({ data: '{"a":2,"b":3}', version: 2 });
    await writer.done;
  });

  it('never returns the mix of two records that happens to be valid JSON', async () => {
    const { store, file, old, whole } = await records('x'.repeat(40), 'y'.repeat(40));
    expect(whole).toHaveLength(old.length);
    const cut = whole.indexOf('y') + 20; // new head, old tail: the line parses, the data is half and half
    const torn = whole.slice(0, cut) + old.slice(cut);
    expect((JSON.parse(torn) as { data: string }).data).toBe('y'.repeat(20) + 'x'.repeat(20));

    const writer = await tearing(file, torn, whole);
    expect(await store.read(KEY)).toEqual({ data: 'y'.repeat(40), version: 2 });
    await writer.done;
  });

  it('still reads a record written without a check, and a file broken for good is a new session', async () => {
    const directory = tempDir('marmeon-session-file-');
    const store = new FileSessionStore(directory, new TestClock());
    const file = join(directory, KEY);
    await writeFile(file, `${JSON.stringify({ expires: Date.now() + 60_000, version: 3, data: 'legacy' })}\n`);
    expect(await store.read(KEY)).toEqual({ data: 'legacy', version: 3 });
    await writeFile(file, '{"expires":');
    expect(await store.read(KEY)).toBeUndefined();
  });

  it("keeps a request's changes when the session it merges into is mid-write", async () => {
    const directory = tempDir('marmeon-session-file-');
    const files = new FileSessionStore(directory, new TestClock());
    let writer: { done: Promise<void> } | undefined;
    // After the first conflict the file is torn until a writer finishes: the retry's read has to wait for it.
    const store: SessionStore = {
      read: (key) => files.read(key),
      destroy: (key) => files.destroy(key),
      gc: (lifetime) => files.gc(lifetime),
      write: async (key, data, options) => {
        const result = await files.write(key, data, options);
        if (result === 'conflict' && !writer) {
          const file = join(directory, key);
          const whole = await readFile(file, 'utf8');
          writer = await tearing(file, whole.slice(0, whole.length >> 1), whole);
        }
        return result;
      },
    };
    const first = new Session(store, config, plainSessionCodec);
    await first.start();
    first.put('base', 1);
    await first.save();
    const slow = new Session(store, config, plainSessionCodec);
    await slow.start(first.id);
    const fast = new Session(store, config, plainSessionCodec);
    await fast.start(first.id);
    fast.put('fast', 1);
    expect(await fast.save()).toBe(true);
    slow.put('slow', 1);
    expect(await slow.save()).toBe(true);
    await writer!.done;

    const merged = new Session(files, config, plainSessionCodec);
    await merged.start(first.id);
    expect([merged.get('base'), merged.get('fast'), merged.get('slow')]).toEqual([1, 1, 1]);
  });
});

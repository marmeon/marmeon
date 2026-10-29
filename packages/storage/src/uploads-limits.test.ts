import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConsoleLogger } from '@marmeon/core';
import { TestClock } from '@marmeon/core/testing';
import { Connections, sql } from '@marmeon/database';
import { HttpError } from '@marmeon/router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatBytes } from './uploads/rule.ts';
import type { Disk } from './disk.ts';
import { ensureBucket, S3_ENDPOINT, s3Options } from './__fixtures__/disks.ts';
import { S3Disk } from './drivers/s3.ts';
import { MemoryDisk } from './drivers/memory.ts';
import { NO_TEMPORARY_URLS } from './temporary.ts';
import { PruneUploadsCommand } from './uploads/commands.ts';
import { UPLOADS_TABLE } from './index.ts';
import { TemporaryUploads, type TargetRequest } from './uploads/service.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

const silent = Object.assign(new ConsoleLogger(), { debug() {}, info() {}, warn() {}, error() {} });
const MB = 1024 * 1024;
const LIFETIME = 2 * 3_600_000;

interface Limits {
  maxOpen: number;
  maxOpenBytes: number;
  maxOpenTotalBytes: number;
}

describe('temporary uploads: what may wait unsent', () => {
  let directory: string;
  let connections: Connections;
  let clock: TestClock;
  let disk: MemoryDisk;

  beforeEach(async () => {
    directory = tempDir('marmeon-uploads-limits-');
    clock = new TestClock();
    clock.freeze();
    disk = new MemoryDisk({ name: 'uploads', visibility: 'private', url: undefined, temporaryUrls: NO_TEMPORARY_URLS, clock });
    connections = new Connections({ connections: { default: { driver: 'sqlite', database: join(directory, 'uploads.sqlite'), managed: false } }, root: directory, logger: silent });
    await sql`
      create table ${sql.table(UPLOADS_TABLE)} (
        id varchar(36) primary key, session varchar(64) not null, route varchar(200) not null, field varchar(200) not null,
        disk varchar(100) not null, key varchar(255) not null, name varchar(255) not null, max_bytes bigint not null, size bigint,
        created_at bigint not null, expires_at bigint not null, started_at bigint, uploaded_at bigint, consumed_at bigint
      )
    `.execute(connections.get());
  });
  afterEach(async () => {
    await connections.destroy();
    rmSync(directory, { recursive: true, force: true });
  });

  function uploads(limits: Partial<Limits> = {}, db: () => unknown = () => connections.get(), on: () => Disk = () => disk): TemporaryUploads {
    return new TemporaryUploads({
      db: db as never,
      disk: on,
      clock,
      keys: [new Uint8Array(32).fill(7)],
      lifetimeMilliseconds: LIFETIME,
      sendWithinSeconds: 900,
      maxOpen: 20,
      maxOpenBytes: 1024 * MB,
      maxOpenTotalBytes: 10_240 * MB,
      receiveUrl: (id) => `/_marmeon/uploads/${id}`,
      ...limits,
    });
  }
  const request = (session: string, size = 10): TargetRequest => ({ route: 'avatar.update', field: 'avatar', rule: { maxBytes: 50 * MB, mime: undefined }, session, name: 'a.png', size });
  const rows = () => connections.get().selectFrom(UPLOADS_TABLE as never).selectAll().execute() as Promise<{ id: string; size: number; session: string }[]>;
  const idOf = async (promise: Promise<{ token: string }>) => (await promise).token.slice(3, 39);
  const bytes = (length: number) => new ReadableStream<Uint8Array>({ start: (controller) => (controller.enqueue(new Uint8Array(length)), controller.close()) });
  const refusal = async (promise: Promise<unknown>) => {
    const error = await promise.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(HttpError);
    return error as HttpError;
  };

  it('a session holds at most UPLOADS_MAX_OPEN open uploads: the next target is a 429 with Retry-After until the first expires', async () => {
    const service = uploads({ maxOpen: 20 });
    for (let index = 0; index < 20; index++) {
      await service.target(request('a'));
      clock.travel({ seconds: 1 });
    }
    const error = await refusal(service.target(request('a')));
    expect(error.status).toBe(429);
    expect(error.translation?.key).toBe('marmeon.validation.upload.too_many');
    expect(error.headers['retry-after']).toBe(String(LIFETIME / 1000 - 20)); // the first target was handed out 20 s ago
    expect(await rows()).toHaveLength(20);
    await service.target(request('b')); // another session is not held back
  });

  it('40 targets at once from one session leave at most 20 rows', async () => {
    const service = uploads();
    const answers = await Promise.allSettled(Array.from({ length: 40 }, () => service.target(request('a'))));
    expect(answers.filter((answer) => answer.status === 'fulfilled')).toHaveLength(20);
    expect(answers.filter((answer) => answer.status === 'rejected' && (answer.reason as HttpError).status === 429)).toHaveLength(20);
    expect(await rows()).toHaveLength(20);
  });

  it('a session may announce at most UPLOADS_MAX_OPEN_MB together', async () => {
    const service = uploads({ maxOpenBytes: 10 * MB });
    await service.target(request('a', 6 * MB));
    expect((await refusal(service.target(request('a', 5 * MB)))).status).toBe(429);
    await service.target(request('a', 4 * MB));
    expect((await rows()).map((row) => Number(row.size))).toEqual([6 * MB, 4 * MB]);
  });

  it('all sessions together may announce at most UPLOADS_MAX_OPEN_TOTAL_MB — 0 turns it off', async () => {
    const limited = uploads({ maxOpenTotalBytes: 10 * MB });
    await limited.target(request('a', 6 * MB));
    expect((await refusal(limited.target(request('b', 5 * MB)))).status).toBe(429);
    await limited.target(request('b', 4 * MB));
    expect((await refusal(limited.target(request('c', 1)))).status).toBe(429);
    await uploads({ maxOpenTotalBytes: 0 }).target(request('c', 30 * MB));
  });

  it('an upload that expired or was used no longer counts', async () => {
    const service = uploads({ maxOpen: 2 });
    const first = await idOf(service.target(request('a')));
    await service.target(request('a'));
    expect((await refusal(service.target(request('a')))).status).toBe(429);
    expect(await service.consume(first)).toBe(true);
    await service.target(request('a'));
    expect((await refusal(service.target(request('a')))).status).toBe(429);
    clock.travel({ milliseconds: LIFETIME });
    await service.target(request('a'));
    await service.target(request('a'));
  });

  it('the bytes of a target are cut off at the size it announced', async () => {
    const service = uploads();
    await expect(service.receive(await idOf(service.target(request('a', 5))), 'a', bytes(6), undefined)).rejects.toMatchObject({ status: 413 });
    disk.assertCount(0);
    expect(await service.receive(await idOf(service.target(request('a', 5))), 'a', bytes(5), undefined)).toBe(5);
    await expect(service.receive(await idOf(service.target(request('a', 5))), 'a', null, 6)).rejects.toMatchObject({ status: 413 });
  });

  it('dimensions() of a received upload reads the size from its first bytes — and is undefined for a file that is no image', async () => {
    const service = uploads();
    const stream = (contents: Uint8Array) => new ReadableStream<Uint8Array>({ start: (controller) => (controller.enqueue(contents), controller.close()) });
    const png = new Uint8Array(2000);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 1, 0x2c, 0, 0, 0, 0xc8]);
    const scope = { session: 'a', route: 'avatar.update', field: 'avatar' };
    for (const [contents, expected] of [[png, { width: 300, height: 200 }], [new TextEncoder().encode('just text, no image'), undefined]] as const) {
      const token = (await service.target(request('a', contents.byteLength))).token;
      await service.receive(token.slice(3, 39), 'a', stream(contents), undefined);
      const found = await service.resolve(token, scope);
      expect(found).toMatchObject({ field: 'avatar' });
      expect(await (found as { dimensions(): Promise<unknown> }).dimensions()).toEqual(expected);
    }
  });

  it('uploads:prune deletes what expired — rows and files — and keeps what is still open', async () => {
    const service = uploads();
    await service.receive(await idOf(service.target(request('a'))), 'a', bytes(3), undefined);
    clock.travel({ milliseconds: LIFETIME - 1000 });
    const open = await idOf(service.target(request('a')));
    disk.assertCount(1);
    clock.travel({ seconds: 1 });

    const command = new PruneUploadsCommand(service, clock, { lifetimeMinutes: 120 } as never);
    const lines: string[] = [];
    expect(await command.handle({ options: {}, args: [], output: { success: (line: string) => lines.push(line), error: () => {} } } as never)).toBe(0);
    expect(lines).toEqual(['Pruned 1 temporary upload.']);
    expect((await rows()).map((row) => row.id)).toEqual([open]);
    disk.assertCount(0);
  });

  it('files of 0 bytes still run into the byte limits: each open upload counts for at least 64 KiB', async () => {
    const service = uploads({ maxOpenBytes: 3 * 64 * 1024 });
    for (let index = 0; index < 3; index++) await service.target(request('a', 0));
    expect((await refusal(service.target(request('a', 0)))).status).toBe(429);
    const total = uploads({ maxOpenTotalBytes: 5 * 64 * 1024 });
    await total.target(request('b', 1));
    await total.target(request('c', 1));
    expect((await refusal(total.target(request('d', 1)))).status).toBe(429);
  });

  it('a file larger than any limit would take is a 422 with the real maximum — not a 429', async () => {
    const error = (await service(uploads({ maxOpenBytes: 5 * MB }), 6 * MB)) as { status: number; message: string };
    expect(error.status).toBe(422);
    expect(error.message).toContain(formatBytes(5 * MB));
    const total = (await service(uploads({ maxOpenTotalBytes: 3 * MB }), 4 * MB)) as { status: number; message: string };
    expect(total.status).toBe(422);
    expect(total.message).toContain(formatBytes(3 * MB));
    expect(await rows()).toEqual([]);

    async function service(uploads: TemporaryUploads, size: number) {
      return uploads.target(request('a', size)).then(
        () => undefined,
        (caught: unknown) => caught,
      );
    }
  });

  it('a limit passed by a request that inserted at the same moment is settled afterwards: the later one gives way and leaves no row', async () => {
    const service = uploads({ maxOpen: 3 });
    await service.target(request('a'));
    await service.target(request('a'));
    // The second request's statement counted 2 before the rival's row was there — the rival commits right after it.
    const rival = uploads({ maxOpen: 99 });
    let injected = false;
    const real = connections.get();
    const racing = new Proxy(real, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property !== 'getExecutor') return typeof value === 'function' ? value.bind(target) : value;
        return () => {
          const executor = target.getExecutor();
          return new Proxy(executor, {
            get(inner, key) {
              const member = Reflect.get(inner, key, inner);
              if (key !== 'executeQuery') return typeof member === 'function' ? member.bind(inner) : member;
              return async (...args: unknown[]) => {
                const result = await (member as (...a: unknown[]) => Promise<unknown>).apply(inner, args);
                if (!injected && String((args[0] as { sql?: string }).sql).trimStart().startsWith('insert')) {
                  injected = true;
                  await rival.target(request('a'));
                }
                return result;
              };
            },
          });
        };
      },
    });
    const slow = uploads({ maxOpen: 3 }, () => racing);
    expect((await refusal(slow.target(request('a')))).status).toBe(429);
    expect(injected).toBe(true);
    expect(await rows()).toHaveLength(3);
  });

  it('an upload that was used before it expired is not pruned by its expiry — only by its age — so a store() in flight keeps its file', async () => {
    const service = uploads();
    const used = await idOf(service.target(request('a')));
    await service.receive(used, 'a', bytes(3), undefined);
    expect(await service.consume(used)).toBe(true);
    clock.travel({ milliseconds: LIFETIME + 1000 });
    expect(await service.prune(clock.now() - 24 * 3_600_000)).toBe(0);
    expect(await rows()).toHaveLength(1);
    expect(await service.prune(clock.now())).toBe(1);
  });

  it.skipIf(!S3_ENDPOINT)('on S3 the POST policy of a target is capped at the size it announced: 6 bytes are refused, 5 accepted', async () => {
    await ensureBucket();
    const s3 = new S3Disk({ name: 'uploads', options: s3Options(`l-${randomUUID()}`, 'private'), visibility: 'private', clock });
    try {
      const service = uploads({}, undefined, () => s3);
      const post = async (size: number, announced: number) => {
        const { upload, token } = await service.target(request('a', announced));
        const form = new FormData();
        for (const [name, value] of Object.entries(upload.fields!)) form.append(name, value);
        form.append('file', new Blob([new Uint8Array(size)]));
        return { response: await fetch(upload.url, { method: 'POST', body: form }), id: token.slice(3, 39) };
      };
      const over = await post(6, 5);
      expect(over.response.status).toBeGreaterThanOrEqual(400);
      expect(await s3.exists(over.id)).toBe(false);
      const exact = await post(5, 5);
      expect(exact.response.status).toBeLessThan(300);
      expect(await s3.size(exact.id)).toBe(5);
    } finally {
      await s3.close();
    }
  });
});

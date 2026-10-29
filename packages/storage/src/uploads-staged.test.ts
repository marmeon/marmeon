import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConsoleLogger } from '@marmeon/core';
import { TestClock } from '@marmeon/core/testing';
import { Connections, sql } from '@marmeon/database';
import { ValidationError } from '@marmeon/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeS3 } from './__fixtures__/s3-fake.ts';
import type { S3DiskOptions } from './config.ts';
import type { Disk } from './disk.ts';
import { MemoryDisk } from './drivers/memory.ts';
import { S3Disk } from './drivers/s3.ts';
import { UPLOADS_TABLE } from './index.ts';
import { NO_TEMPORARY_URLS } from './temporary.ts';
import { StagedUploads, TemporaryUploads } from './uploads/service.ts';
import { RejectedUpload, TemporaryUpload } from './uploads/temporary-upload.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

const silent = Object.assign(new ConsoleLogger(), { debug() {}, info() {}, warn() {}, error() {} });
const HOUR = 3_600_000;
const LIFETIME = 2 * HOUR;
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const HTML = new TextEncoder().encode('<html><script>alert(1)</script></html>');
const CSV = new TextEncoder().encode('name;email\nAda;ada@example.com\n');
const SCOPE = { session: 's', route: 'import.preview', field: 'file' };

describe('an upload kept for later requests of its session', () => {
  let directory: string;
  let connections: Connections;
  let clock: TestClock;
  let disk: MemoryDisk;

  beforeEach(async () => {
    directory = tempDir('marmeon-uploads-staged-');
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

  const service = (limits: { maxOpen?: number } = {}, on: () => Disk = () => disk) =>
    new TemporaryUploads({
      db: (() => connections.get()) as never,
      disk: on,
      clock,
      keys: [new Uint8Array(32).fill(7)],
      lifetimeMilliseconds: LIFETIME,
      sendWithinSeconds: 900,
      maxOpen: 20,
      maxOpenBytes: 1024 * 1024 * 1024,
      maxOpenTotalBytes: 0,
      receiveUrl: (id) => `/_marmeon/uploads/${id}`,
      ...limits,
    });
  const stream = (contents: Uint8Array) => new ReadableStream<Uint8Array>({ start: (controller) => (controller.enqueue(contents), controller.close()) });
  const row = async (id: string) => (await connections.get().selectFrom(UPLOADS_TABLE as never).selectAll().where('id' as never, '=', id as never).executeTakeFirst()) as { route: string; expires_at: number; created_at: number } | undefined;

  /** An upload sent and checked in session `s`, as the request that received the form sees it. */
  async function checked(uploads: TemporaryUploads, contents = CSV, session = 's') {
    const { token } = await uploads.target({ route: SCOPE.route, field: SCOPE.field, rule: { maxBytes: 1000, mime: undefined }, session, name: 'data.csv', size: contents.byteLength });
    await uploads.receive(token.slice(3, 39), session, stream(contents), undefined);
    const found = await uploads.resolve(token, { ...SCOPE, session });
    expect(found).toBeInstanceOf(TemporaryUpload);
    return { upload: found as TemporaryUpload, token, id: token.slice(3, 39) };
  }
  const keep = { scope: 'products-import', minutes: 30 };

  it('keep() returns the id, and the next request finds the upload again for its session and scope, with the file readable', async () => {
    const uploads = service();
    const { upload, id } = await checked(uploads);
    expect(await upload.keep(keep)).toBe(id);
    const found = await uploads.staged('s', id, 'products-import');
    expect(found).toMatchObject({ id, field: 'file', name: 'data.csv', size: CSV.byteLength });
    expect(await found!.bytes()).toEqual(CSV);
    expect(found!.mime).toBe('application/octet-stream');
    // The wait restarts at 30 minutes, and the stored route no longer is the form's.
    expect(Number((await row(id))!.expires_at)).toBe(clock.now() + 30 * 60_000);
    expect((await row(id))!.route).toBe('staged:products-import');
  });

  it('the old token stops working once the upload is kept: it belongs to the flow now, not to the form', async () => {
    const uploads = service();
    const { upload, token } = await checked(uploads);
    await upload.keep(keep);
    expect(await uploads.resolve(token, SCOPE)).toBeInstanceOf(RejectedUpload);
  });

  it('only the session that made the upload finds it: another session, no session and a made-up id get the same undefined', async () => {
    const uploads = service();
    const { upload, id } = await checked(uploads);
    await upload.keep(keep);
    expect(await uploads.staged('someone-else', id, 'products-import')).toBeUndefined();
    expect(await uploads.staged(undefined, id, 'products-import')).toBeUndefined();
    expect(await uploads.staged('s', '11111111-1111-4111-8111-111111111111', 'products-import')).toBeUndefined();
    expect(await uploads.staged('s', "x' or '1'='1", 'products-import')).toBeUndefined();
    expect(await uploads.staged('s', id, 'products-import')).toBeInstanceOf(TemporaryUpload);
  });

  it('only the scope it was kept under finds it, and an upload that was not kept is not found by id at all', async () => {
    const uploads = service();
    const kept = await checked(uploads);
    const loose = await checked(uploads);
    await kept.upload.keep(keep);
    expect(await uploads.staged('s', kept.id, 'other-flow')).toBeUndefined();
    expect(await uploads.staged('s', kept.id, 'products-import extra')).toBeUndefined();
    expect(await uploads.staged('s', kept.id, 'products')).toBeUndefined(); // a prefix of the scope is not the scope
    expect(await uploads.staged('s', loose.id, 'import.preview')).toBeUndefined();
    expect(await uploads.staged('s', loose.id, 'products-import')).toBeUndefined();
  });

  it('prune by age spares a kept upload while it waits and removes it once expired; a used upload of that age is removed', async () => {
    const uploads = service();
    const kept = await checked(uploads);
    await kept.upload.keep({ scope: 'products-import', minutes: 600 });
    const used = await checked(uploads);
    await used.upload.store(new MemoryDisk({ name: 'public', visibility: 'private', url: undefined, temporaryUrls: NO_TEMPORARY_URLS, clock }));
    const plain = await checked(uploads);
    clock.travel({ hours: 1 });
    expect(await uploads.prune(clock.now() - 30 * 60_000)).toBe(2); // the used one and the unkept one (its token's wait is not over: age only)
    expect(await row(kept.id)).toBeDefined();
    expect(await row(used.id)).toBeUndefined();
    expect(await row(plain.id)).toBeUndefined();
    disk.assertCount(1);
    clock.travel({ hours: 10 });
    expect(await uploads.prune(clock.now() - 30 * 60_000)).toBe(1);
    expect(await row(kept.id)).toBeUndefined();
    disk.assertCount(0);
  });

  it('expires: after its minutes it is not found, and uploads:prune removes the file and the row', async () => {
    const uploads = service();
    const { upload, id } = await checked(uploads);
    await upload.keep(keep);
    clock.travel({ minutes: 29 });
    expect(await uploads.staged('s', id, 'products-import')).toBeInstanceOf(TemporaryUpload);
    clock.travel({ minutes: 1 });
    expect(await uploads.staged('s', id, 'products-import')).toBeUndefined();
    disk.assertCount(1);
    expect(await uploads.prune(clock.now() - 24 * HOUR)).toBe(1);
    disk.assertCount(0);
    expect(await row(id)).toBeUndefined();
  });

  it('holding it again restarts the wait but never past 24 hours after it was made', async () => {
    const uploads = service();
    const { upload, id } = await checked(uploads);
    const made = clock.now();
    clock.travel({ hours: 1 });
    await upload.keep({ scope: 'products-import', minutes: 1440 });
    clock.travel({ hours: 22 });
    const found = (await uploads.staged('s', id, 'products-import'))!;
    expect(Number((await row(id))!.expires_at)).toBe(made + 24 * HOUR);
    await found.keep({ scope: 'products-import', minutes: 1440 });
    expect(Number((await row(id))!.expires_at)).toBe(made + 24 * HOUR);
    clock.travel({ hours: 1 });
    expect(await uploads.staged('s', id, 'products-import')).toBeUndefined();
  });

  it('keep() refuses a scope or minutes out of range, and an upload that was used or has expired, with a TypeError', async () => {
    const uploads = service();
    const { upload, id } = await checked(uploads);
    for (const bad of [{ scope: '', minutes: 5 }, { scope: 'a b', minutes: 5 }, { scope: 'a/b', minutes: 5 }, { scope: 'x'.repeat(101), minutes: 5 }, { scope: 'ok', minutes: 0 }, { scope: 'ok', minutes: 1441 }, { scope: 'ok', minutes: 1.5 }]) {
      await expect(upload.keep(bad)).rejects.toBeInstanceOf(TypeError);
    }
    expect((await row(id))!.route).toBe(SCOPE.route);
    await upload.store(new MemoryDisk({ name: 'public', visibility: 'private', url: undefined, temporaryUrls: NO_TEMPORARY_URLS, clock }));
    await expect(upload.keep(keep)).rejects.toBeInstanceOf(TypeError);

    const used = await checked(uploads);
    expect(await uploads.consume(used.id)).toBe(true);
    await expect(used.upload.keep(keep)).rejects.toThrow('used or has expired');
    expect((await row(used.id))!.route).toBe(SCOPE.route);

    const late = await checked(uploads);
    clock.travel({ milliseconds: LIFETIME });
    await expect(late.upload.keep(keep)).rejects.toBeInstanceOf(TypeError);
  });

  it('store() uses a kept upload up once: afterwards it is not found, and a second store is a 422', async () => {
    const uploads = service();
    const { upload, id } = await checked(uploads);
    await upload.keep(keep);
    const found = (await uploads.staged('s', id, 'products-import'))!;
    const target = new MemoryDisk({ name: 'public', visibility: 'private', url: undefined, temporaryUrls: NO_TEMPORARY_URLS, clock });
    const key = await found.store(target, 'imports');
    expect(await target.get(key)).toEqual(CSV);
    expect(await uploads.staged('s', id, 'products-import')).toBeUndefined();
    await expect((await checked(uploads)).upload.store(target)).resolves.toBeTypeOf('string');
    await expect(found.store(target)).rejects.toBeInstanceOf(ValidationError);
    disk.assertCount(0);
  });

  it('an upload used up while its file is still there (a store() in flight) is not found', async () => {
    const uploads = service();
    const { upload, id } = await checked(uploads);
    await upload.keep(keep);
    expect(await uploads.consume(id)).toBe(true);
    expect(await uploads.staged('s', id, 'products-import')).toBeUndefined();
  });

  it('a kept upload still counts against the open uploads of its session until it is used or discarded', async () => {
    const uploads = service({ maxOpen: 1 });
    const { upload, id } = await checked(uploads);
    await upload.keep(keep);
    const request = { route: SCOPE.route, field: 'file', rule: { maxBytes: 1000, mime: undefined }, session: 's', name: 'a.csv', size: 3 };
    await expect(uploads.target(request)).rejects.toMatchObject({ status: 429 });
    expect(await (await uploads.staged('s', id, 'products-import'))!.discard()).toBe(true);
    await expect(uploads.target(request)).resolves.toBeDefined();
  });

  it('discard() deletes the file and the row, and is false for an upload used already', async () => {
    const uploads = service();
    const { upload, id } = await checked(uploads);
    await upload.keep(keep);
    expect(await upload.discard()).toBe(true);
    disk.assertCount(0);
    expect(await row(id)).toBeUndefined();
    expect(await uploads.staged('s', id, 'products-import')).toBeUndefined();
    expect(await upload.discard()).toBe(false);

    const used = await checked(uploads);
    const target = new MemoryDisk({ name: 'public', visibility: 'private', url: undefined, temporaryUrls: NO_TEMPORARY_URLS, clock });
    const key = await used.upload.store(target);
    expect(await used.upload.discard()).toBe(false);
    expect(await target.get(key)).toEqual(CSV);
  });

  it('StagedUploads takes the session from the request, and finds nothing without one', async () => {
    const uploads = service();
    const { upload, id } = await checked(uploads);
    await upload.keep(keep);
    expect(await new StagedUploads(uploads, () => 's').staged(id, 'products-import')).toBeInstanceOf(TemporaryUpload);
    expect(await new StagedUploads(uploads, () => 'another').staged(id, 'products-import')).toBeUndefined();
    expect(await new StagedUploads(uploads, () => undefined).staged(id, 'products-import')).toBeUndefined();
  });
});

describe('a kept upload on S3', () => {
  let directory: string;
  let connections: Connections;
  let clock: TestClock;

  beforeEach(async () => {
    directory = tempDir('marmeon-uploads-staged-s3-');
    clock = new TestClock();
    clock.freeze();
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

  const options: S3DiskOptions = { driver: 's3', bucket: 'uploads', region: 'us-east-1', endpoint: 'http://store-a.test', credentials: { accessKeyId: 'a', secretAccessKey: 's' }, root: '', visibility: 'private' };

  async function target(fake: FakeS3, contents: Uint8Array) {
    const disk = new S3Disk({ name: 'uploads', options, visibility: 'private', clock, load: fake.load });
    vi.spyOn(disk, 'presignedPost').mockResolvedValue({ url: 'http://store-a.test/uploads', fields: {} });
    const uploads = new TemporaryUploads({
      db: (() => connections.get()) as never,
      disk: () => disk,
      clock,
      keys: [new Uint8Array(32).fill(7)],
      lifetimeMilliseconds: LIFETIME,
      sendWithinSeconds: 900,
      maxOpen: 20,
      maxOpenBytes: 1024 * 1024 * 1024,
      maxOpenTotalBytes: 0,
      receiveUrl: (id) => `/_marmeon/uploads/${id}`,
    });
    const { token } = await uploads.target({ route: SCOPE.route, field: SCOPE.field, rule: { maxBytes: 1000, mime: undefined }, session: 's', name: 'a.png', size: contents.byteLength });
    const id = token.slice(3, 39);
    fake.post('uploads', id, contents);
    return { disk, uploads, token, id };
  }

  it('staged() reads the type again: a file replaced through the policy after keep() as HTML is not returned', async () => {
    const fake = new FakeS3();
    const { uploads, token, id } = await target(fake, PNG);
    const found = (await uploads.resolve(token, SCOPE)) as TemporaryUpload;
    await found.keep({ scope: 'avatar-crop', minutes: 10 });
    expect((await uploads.staged('s', id, 'avatar-crop'))!.mime).toBe('image/png');
    fake.post('uploads', id, HTML);
    expect(await uploads.staged('s', id, 'avatar-crop')).toBeUndefined();
  });

  it('a kept object swapped through the policy for another type is refused: a PNG for a PDF, a CSV for a binary', async () => {
    const PDF = new TextEncoder().encode('%PDF-1.7\n1 0 obj');
    const BINARY = Uint8Array.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe]);
    for (const [original, swapped] of [[PNG, PDF], [CSV, BINARY], [CSV, PNG]] as const) {
      const fake = new FakeS3();
      const { uploads, token, id } = await target(fake, original);
      await ((await uploads.resolve(token, SCOPE)) as TemporaryUpload).keep({ scope: 'flow', minutes: 10 });
      expect(await uploads.staged('s', id, 'flow')).toBeInstanceOf(TemporaryUpload);
      expect(await uploads.staged('s', id, 'flo')).toBeUndefined();
      fake.post('uploads', id, swapped);
      expect(await uploads.staged('s', id, 'flow')).toBeUndefined();
    }
  });

  it('staged() refuses a file larger than the field allowed: a policy that was posted to again cannot grow it', async () => {
    const fake = new FakeS3();
    const { uploads, token, id } = await target(fake, PNG);
    await ((await uploads.resolve(token, SCOPE)) as TemporaryUpload).keep({ scope: 'avatar-crop', minutes: 10 });
    const grown = new Uint8Array(1001);
    grown.set(PNG);
    fake.post('uploads', id, grown);
    expect(await uploads.staged('s', id, 'avatar-crop')).toBeUndefined();
  });

  it('a file replaced after staged() found it is pinned by the ETag: bytes() and store() refuse the new one', async () => {
    const fake = new FakeS3();
    const { uploads, token, id } = await target(fake, PNG);
    await ((await uploads.resolve(token, SCOPE)) as TemporaryUpload).keep({ scope: 'avatar-crop', minutes: 10 });
    const staged = (await uploads.staged('s', id, 'avatar-crop'))!;
    fake.post('uploads', id, HTML);
    await expect(staged.bytes()).rejects.toBeInstanceOf(ValidationError);
    await expect(staged.store(new MemoryDisk({ name: 'public', visibility: 'private', url: undefined, temporaryUrls: NO_TEMPORARY_URLS, clock }))).rejects.toBeInstanceOf(ValidationError);
  });

  it('discard() and uploads:prune remove the object', async () => {
    const fake = new FakeS3();
    const first = await target(fake, PNG);
    await ((await first.uploads.resolve(first.token, SCOPE)) as TemporaryUpload).keep({ scope: 'avatar-crop', minutes: 10 });
    expect(fake.objects.has(`uploads/${first.id}`)).toBe(true);
    expect(await (await first.uploads.staged('s', first.id, 'avatar-crop'))!.discard()).toBe(true);
    expect(fake.objects.has(`uploads/${first.id}`)).toBe(false);

    const second = await target(fake, PNG);
    await ((await second.uploads.resolve(second.token, SCOPE)) as TemporaryUpload).keep({ scope: 'avatar-crop', minutes: 10 });
    clock.travel({ minutes: 10 });
    expect(await second.uploads.prune(clock.now() - 24 * HOUR)).toBe(1);
    expect(fake.objects.has(`uploads/${second.id}`)).toBe(false);
  });
});

import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConsoleLogger } from '@marmeon/core';
import { TestClock } from '@marmeon/core/testing';
import { Connections, sql } from '@marmeon/database';
import { ValidationError } from '@marmeon/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureBucket, S3_ENDPOINT, s3Options } from './__fixtures__/disks.ts';
import { FakeS3 } from './__fixtures__/s3-fake.ts';
import type { S3DiskOptions } from './config.ts';
import type { Disk } from './disk.ts';
import { MemoryDisk } from './drivers/memory.ts';
import { S3Disk } from './drivers/s3.ts';
import { UPLOADS_TABLE } from './index.ts';
import { NO_TEMPORARY_URLS } from './temporary.ts';
import { TemporaryUploads } from './uploads/service.ts';
import { RejectedUpload, TemporaryUpload } from './uploads/temporary-upload.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

const silent = Object.assign(new ConsoleLogger(), { debug() {}, info() {}, warn() {}, error() {} });

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const HTML = new TextEncoder().encode('<html><script>alert(1)</script></html>');

/** A PNG header followed by `length` bytes — big enough to need many chunks. */
function bigPng(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes.set(PNG);
  return bytes;
}

describe('an uploaded S3 object is pinned by its ETag from the check to the store', () => {
  let directory: string;
  let connections: Connections;
  let clock: TestClock;

  beforeEach(async () => {
    directory = tempDir('marmeon-uploads-pinned-');
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

  const service = (disk: Disk) =>
    new TemporaryUploads({
      db: (() => connections.get()) as never,
      disk: () => disk,
      clock,
      keys: [new Uint8Array(32).fill(7)],
      lifetimeMilliseconds: 3_600_000,
      sendWithinSeconds: 900,
      maxOpen: 20,
      maxOpenBytes: 1024 * 1024 * 1024,
      maxOpenTotalBytes: 0,
      receiveUrl: (id) => `/_marmeon/uploads/${id}`,
    });
  const SCOPE = { session: 's', route: 'avatar.update', field: 'avatar' };
  const request = (size: number) => ({ ...SCOPE, rule: { maxBytes: 100 * 1024 * 1024, mime: undefined }, name: 'a.png', size });
  const options = (endpoint: string): S3DiskOptions => ({ driver: 's3', bucket: 'uploads', region: 'us-east-1', endpoint, credentials: { accessKeyId: 'a', secretAccessKey: 's' }, root: '', visibility: 'private' });
  const memory = () => new MemoryDisk({ name: 'public', visibility: 'private', url: undefined, temporaryUrls: NO_TEMPORARY_URLS, clock });
  const upload = (found: TemporaryUpload | RejectedUpload) => {
    expect(found).toBeInstanceOf(TemporaryUpload);
    return found as TemporaryUpload;
  };

  /** A target on a disk backed by `fake`, whose browser POST the test plays itself. */
  async function target(fake: FakeS3, size = PNG.byteLength, endpoint = 'http://store-a.test') {
    const disk = new S3Disk({ name: 'uploads', options: options(endpoint), visibility: 'private', clock, load: fake.load });
    vi.spyOn(disk, 'presignedPost').mockResolvedValue({ url: 'http://store-a.test/uploads', fields: {} });
    const uploads = service(disk);
    const { token } = await uploads.target(request(size));
    return { disk, uploads, token, id: token.slice(3, 39) };
  }

  it('the service marks a file as text only when it is nothing but text — a CSV, not UTF-16 HTML or a PNG', async () => {
    const encode = (value: string, bom: number[]) => Uint8Array.from([...bom, ...[...value].flatMap((c) => [c.charCodeAt(0), 0])]);
    for (const [head, text] of [
      [new TextEncoder().encode('a;b\n1;2\n'), true],
      [encode('a,b\n', [0xff, 0xfe]), true],
      [encode('<html><script>alert(1)</script>', [0xff, 0xfe]), false],
      [PNG, false],
    ] as const) {
      const fake = new FakeS3();
      const { uploads, token, id } = await target(fake, head.byteLength);
      fake.post('uploads', id, head);
      expect(upload(await uploads.resolve(token, SCOPE)).plainText).toBe(text);
    }
  });

  it('a second POST to the policy after the check: store() refuses and nothing lands', async () => {
    const fake = new FakeS3();
    const { uploads, token, id } = await target(fake);
    fake.post('uploads', id, PNG);
    const checked = upload(await uploads.resolve(token, SCOPE));
    expect(checked.mime).toBe('image/png');
    fake.post('uploads', id, HTML); // the policy still allows it
    const elsewhere = memory();
    await expect(checked.store(elsewhere, 'avatars')).rejects.toBeInstanceOf(ValidationError);
    expect(await elsewhere.list('', { recursive: true })).toEqual([]);
    expect(fake.objects.has(`uploads/${id}`)).toBe(false);
    await expect(checked.store(elsewhere, 'avatars')).rejects.toMatchObject({ issues: [{ message: expect.stringContaining('saved already') }] });
  });

  it('the same after the check, with the destination on the same store: the copy refuses and nothing lands', async () => {
    const fake = new FakeS3();
    const { disk, uploads, token, id } = await target(fake);
    fake.post('uploads', id, PNG);
    const checked = upload(await uploads.resolve(token, SCOPE));
    fake.post('uploads', id, HTML);
    await expect(checked.store(disk, 'avatars')).rejects.toBeInstanceOf(ValidationError);
    expect([...fake.objects.keys()].filter((id) => id.startsWith('uploads/avatars/'))).toEqual([]);
    expect(fake.calledWith('CopyObject')[0]).toMatchObject({ CopySourceIfMatch: expect.any(String) });
    expect(fake.objects.has(`uploads/${id}`)).toBe(false);
    await expect(checked.store(disk, 'avatars')).rejects.toMatchObject({ issues: [{ message: expect.stringContaining('saved already') }] });
  });

  it('a store that answers without an ETag cannot pin the object: invalid', async () => {
    const fake = new FakeS3();
    const { uploads, token, id } = await target(fake);
    fake.post('uploads', id, PNG);
    fake.headWithoutEtag = true;
    expect(await uploads.resolve(token, SCOPE)).toEqual(new RejectedUpload('invalid'));
  });

  it('a POST between the size check and the first bytes: invalid', async () => {
    const fake = new FakeS3();
    const { uploads, token, id } = await target(fake);
    fake.post('uploads', id, PNG);
    fake.beforeGet = () => {
      fake.beforeGet = undefined;
      fake.post('uploads', id, HTML);
    };
    expect(await uploads.resolve(token, SCOPE)).toEqual(new RejectedUpload('invalid'));
  });

  it('a second POST before the check is what the check sees — and what is stored', async () => {
    const fake = new FakeS3();
    const { uploads, token, id } = await target(fake);
    fake.post('uploads', id, HTML);
    fake.post('uploads', id, PNG);
    const checked = upload(await uploads.resolve(token, SCOPE));
    const elsewhere = memory();
    const key = await checked.store(elsewhere, 'avatars');
    expect(await elsewhere.get(key)).toEqual(PNG);
    expect(fake.calledWith('GetObject').every((get) => typeof get.IfMatch === 'string')).toBe(true);
  });

  it('storing a large file on another store streams it with its length — no chunk is the whole file', async () => {
    const size = 8 * 1024 * 1024;
    const source = new FakeS3();
    const destination = new FakeS3();
    const { uploads, token, id } = await target(source, size);
    source.post('uploads', id, bigPng(size));
    const checked = upload(await uploads.resolve(token, SCOPE));
    const other = new S3Disk({ name: 'public', options: { ...options('http://store-b.test'), bucket: 'public' }, visibility: 'private', clock, load: destination.load });
    const key = await checked.store(other, 'avatars');
    expect(destination.objects.get(`public/${key}`)?.bytes.byteLength).toBe(size);
    expect(destination.calledWith('PutObject')[0]).toMatchObject({ ContentLength: size, ContentType: 'image/png' });
    expect(destination.biggestPutChunk).toBeLessThanOrEqual(256 * 1024);
    expect(source.calledWith('CopyObject')).toEqual([]);
  });

  it('storing on the same store copies on the store’s side — the bytes do not pass through the app', async () => {
    const size = 8 * 1024 * 1024;
    const fake = new FakeS3();
    const { disk, uploads, token, id } = await target(fake, size);
    fake.post('uploads', id, bigPng(size));
    const checked = upload(await uploads.resolve(token, SCOPE));
    const key = await checked.store(disk, 'avatars');
    expect(fake.calledWith('PutObject')).toEqual([]);
    expect(fake.objects.get(`uploads/${key}`)).toMatchObject({ contentType: 'image/png' });
    expect(fake.calledWith('GetObject').length).toBe(1); // only the first bytes
    expect(fake.calledWith('DeleteObject')).toHaveLength(1);
  });

  /** A PNG header for a picture of 300 × 200, followed by `length` bytes. */
  function pngOf(length: number): Uint8Array {
    const bytes = new Uint8Array(length);
    bytes.set(PNG);
    bytes.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 1, 0x2c, 0, 0, 0, 0xc8], 8);
    return bytes;
  }

  it('dimensions() reads only the first bytes of the object — a ranged read pinned by the ETag', async () => {
    const size = 8 * 1024 * 1024;
    const fake = new FakeS3();
    const { uploads, token, id } = await target(fake, size);
    fake.post('uploads', id, pngOf(size));
    const checked = upload(await uploads.resolve(token, SCOPE));
    expect(await checked.dimensions()).toEqual({ width: 300, height: 200 });
    const ranged = fake.calledWith('GetObject').filter((input) => input.Range !== undefined);
    expect(ranged).toHaveLength(1);
    expect(ranged[0]).toMatchObject({ Range: 'bytes=0-262143', IfMatch: expect.any(String) });
  });

  it('dimensions() of an object that was posted again after the check is undefined, not the new file’s size', async () => {
    const fake = new FakeS3();
    const { uploads, token, id } = await target(fake, 1024);
    fake.post('uploads', id, pngOf(1024));
    const checked = upload(await uploads.resolve(token, SCOPE));
    fake.post('uploads', id, HTML);
    expect(await checked.dimensions()).toBeUndefined();
  });

  it.skipIf(!S3_ENDPOINT)('against a real store: dimensions() reads the size of a large object from a range', async () => {
    await ensureBucket();
    const s3 = new S3Disk({ name: 'uploads', options: s3Options(`p-${randomUUID()}`, 'private'), visibility: 'private', clock });
    try {
      const uploads = service(s3);
      const contents = pngOf(2 * 1024 * 1024);
      const { upload: policy, token } = await uploads.target(request(contents.byteLength));
      const form = new FormData();
      for (const [name, value] of Object.entries(policy.fields!)) form.append(name, value);
      form.append('file', new Blob([new Uint8Array(contents)]));
      expect((await fetch(policy.url, { method: 'POST', body: form })).status).toBeLessThan(300);
      const checked = upload(await uploads.resolve(token, SCOPE));
      expect(await checked.dimensions()).toEqual({ width: 300, height: 200 });
    } finally {
      await s3.close();
    }
  });

  it.skipIf(!S3_ENDPOINT)('against a real store: two POSTs to one policy — the second is refused at store(), on the same store and on another disk', async () => {
    await ensureBucket();
    const s3 = new S3Disk({ name: 'uploads', options: s3Options(`p-${randomUUID()}`, 'private'), visibility: 'private', clock });
    try {
      const uploads = service(s3);
      for (const destination of [s3, memory()]) {
        const { upload: policy, token } = await uploads.target(request(PNG.byteLength + HTML.byteLength));
        const post = async (contents: Uint8Array<ArrayBuffer>) => {
          const form = new FormData();
          for (const [name, value] of Object.entries(policy.fields!)) form.append(name, value);
          form.append('file', new Blob([contents]));
          expect((await fetch(policy.url, { method: 'POST', body: form })).status).toBeLessThan(300);
        };
        await post(new Uint8Array(PNG));
        const checked = upload(await uploads.resolve(token, SCOPE));
        expect(checked.mime).toBe('image/png');
        await post(new Uint8Array(HTML));
        await expect(checked.store(destination, 'avatars')).rejects.toBeInstanceOf(ValidationError);
        expect(await destination.list('avatars', { recursive: true })).toEqual([]);
      }
    } finally {
      await s3.close();
    }
  });

  it.skipIf(!S3_ENDPOINT)('against a real store: a file is stored by copy and by stream, byte for byte', async () => {
    await ensureBucket();
    const s3 = new S3Disk({ name: 'uploads', options: s3Options(`p-${randomUUID()}`, 'private'), visibility: 'private', clock });
    // Another region counts as another store: the file is streamed, not copied.
    const other = new S3Disk({ name: 'public', options: { ...s3Options(`q-${randomUUID()}`, 'private'), region: 'eu-west-1' }, visibility: 'private', clock });
    try {
      const uploads = service(s3);
      for (const destination of [s3, other, memory()]) {
        const size = 3 * 1024 * 1024;
        const { upload: policy, token } = await uploads.target(request(size));
        const form = new FormData();
        for (const [name, value] of Object.entries(policy.fields!)) form.append(name, value);
        form.append('file', new Blob([bigPng(size) as Uint8Array<ArrayBuffer>]));
        expect((await fetch(policy.url, { method: 'POST', body: form })).status).toBeLessThan(300);
        const key = await upload(await uploads.resolve(token, SCOPE)).store(destination, 'avatars');
        expect(await destination.size(key)).toBe(size);
        expect(await destination.mimeType(key)).toBe('image/png');
      }
    } finally {
      await s3.close();
      await other.close();
    }
  });
});

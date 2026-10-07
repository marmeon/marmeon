import { randomUUID } from 'node:crypto';
import { TestClock } from '@marmeon/core';
import * as v from 'valibot';
import { afterAll, describe, expect, it } from 'vitest';
import { ensureBucket, S3_ENDPOINT, s3Options } from './__fixtures__/disks.ts';
import { MemoryDisk } from './drivers/memory.ts';
import { S3Disk } from './drivers/s3.ts';
import { NO_TEMPORARY_URLS } from './temporary.ts';
import { formatBytes, upload, uploadFields } from './uploads/rule.ts';
import { sniff } from './uploads/sniff.ts';
import { RejectedUpload, TemporaryUpload } from './uploads/temporary-upload.ts';

const bytes = (...values: (number | string)[]) => new Uint8Array(values.flatMap((value) => (typeof value === 'string' ? [...value].map((c) => c.charCodeAt(0)) : [value])));
const text = (value: string) => new TextEncoder().encode(value);

describe('sniff — a file’s type by its first bytes (W6.9), never by its name', () => {
  it('recognises the formats with a signature', () => {
    expect(sniff(bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0))).toEqual({ mime: 'image/png', extension: 'png' });
    expect(sniff(bytes(0xff, 0xd8, 0xff, 0xe0))).toEqual({ mime: 'image/jpeg', extension: 'jpg' });
    expect(sniff(bytes('GIF89a', 1))).toEqual({ mime: 'image/gif', extension: 'gif' });
    expect(sniff(bytes('RIFF', 0, 0, 0, 0, 'WEBPVP8 '))).toEqual({ mime: 'image/webp', extension: 'webp' });
    expect(sniff(bytes(0, 0, 0, 28, 'ftypavif', 0, 0, 0, 0, 'mif1miaf'))).toEqual({ mime: 'image/avif', extension: 'avif' });
    expect(sniff(bytes(0, 0, 0, 24, 'ftypisom', 0, 0, 2, 0, 'isomiso2'))).toEqual({ mime: 'video/mp4', extension: 'mp4' });
    expect(sniff(text('%PDF-1.7\n'))).toEqual({ mime: 'application/pdf', extension: 'pdf' });
    expect(sniff(bytes('PK', 3, 4))).toEqual({ mime: 'application/zip', extension: 'zip' });
    expect(sniff(text('just some text'))).toEqual({ mime: 'application/octet-stream', extension: 'bin' });
    expect(sniff(new Uint8Array())).toEqual({ mime: 'application/octet-stream', extension: 'bin' });
  });

  it('recognises markup a browser would run — HTML, SVG, XML — after a BOM, whitespace and in any case', () => {
    for (const html of ['<!DOCTYPE html><p>', '﻿ \n<HTML><body>', '<script>alert(1)</script>', '<iframe src=x>', '<!-- x --><b>']) expect(sniff(text(html)).mime).toBe('text/html');
    for (const svg of ['<svg xmlns="http://www.w3.org/2000/svg">', '<?xml version="1.0"?><svg>', '  <SVG onload=alert(1)>']) expect(sniff(text(svg)).mime).toBe('image/svg+xml');
    expect(sniff(text('<?xml version="1.0"?><note/>')).mime).toBe('application/xml');
  });
});

describe('upload() — the rule of an upload field', () => {
  const schema = v.object({ avatar: upload({ maxBytes: 2_000_000, mime: ['image/png', 'image/jpeg'] }) });
  const verified = (mime: string, size = 10) => new TemporaryUpload({ id: 'x', field: 'avatar', name: 'a', size, mime, extension: 'png' }, { disk: undefined!, key: 'x', consume: async () => true });
  const issues = (avatar: unknown) => v.safeParse(schema, { avatar }).issues?.map((issue) => issue.message);

  it('passes a verified upload of an allowed type and size — the field is the TemporaryUpload', () => {
    const upload = verified('image/png');
    expect(v.parse(schema, { avatar: upload }).avatar).toBe(upload);
  });

  it('refuses what is not a verified upload: nothing, a token it never verified, a refused one, a file', () => {
    expect(issues(null)).toEqual(['Choose a file.']);
    expect(issues('tu_x.y')).toEqual(['The file did not arrive — choose it again.']);
    expect(issues(new RejectedUpload('expired'))).toEqual(['The upload expired — choose the file again.']);
    expect(issues(new RejectedUpload('used'))).toEqual(['This file was saved already — choose it again.']);
    expect(issues(new File(['x'], 'a.png'))).toEqual(['The file did not arrive — choose it again.']);
  });

  it('refuses a type the rule does not name — and markup always, even without `mime`', () => {
    expect(issues(verified('image/gif'))).toEqual(['This type of file is not accepted (allowed: PNG, JPG).']);
    expect(issues(verified('text/html'))).toEqual(['This type of file is not accepted (allowed: PNG, JPG).']);
    const any = v.object({ file: upload({ maxBytes: 100 }) });
    expect(v.safeParse(any, { file: verified('application/octet-stream') }).success).toBe(true);
    for (const markup of ['text/html', 'image/svg+xml', 'application/xml']) expect(v.safeParse(any, { file: verified(markup) }).success).toBe(false);
  });

  it('refuses a file over maxBytes (checked again on submit)', () => {
    expect(issues(verified('image/png', 2_000_001))).toEqual(['The file may be at most 2 MB.']);
    expect([formatBytes(1536), formatBytes(999), formatBytes(2_500_000)]).toEqual(['1.5 KB', '999 bytes', '2.5 MB']);
  });

  it('is found in a body schema by path — through optional/nullish and pipes, in nested objects', () => {
    const rule = { maxBytes: 5, mime: undefined };
    const found = uploadFields(
      v.object({
        name: v.string(),
        avatar: v.nullish(upload({ maxBytes: 5 })),
        cv: v.pipe(upload({ maxBytes: 5 }), v.check(() => true)),
        profile: v.object({ photo: v.optional(upload({ maxBytes: 5 })) }),
      }),
    );
    expect(Object.fromEntries(found)).toEqual({ avatar: rule, cv: rule, 'profile.photo': rule });
  });
});

/** Against the S3-compatible test container (`pnpm test:s3`): the presigned POST of an upload (W6.9). */
describe.skipIf(!S3_ENDPOINT)('uploads straight to S3: a presigned POST with a size limit', () => {
  const disks: S3Disk[] = [];
  const make = async () => {
    await ensureBucket();
    const disk = new S3Disk({ name: 'uploads', options: s3Options(`u-${randomUUID()}`, 'private'), visibility: 'private', clock: new TestClock() });
    disks.push(disk);
    return disk;
  };
  afterAll(async () => {
    for (const disk of disks) await disk.close();
  });
  const post = async (target: { url: string; fields: Record<string, string> }, contents: Uint8Array<ArrayBuffer>, key?: string) => {
    const form = new FormData();
    for (const [name, value] of Object.entries(target.fields)) form.append(name, name === 'key' && key ? key : value);
    form.append('file', new Blob([contents]));
    return fetch(target.url, { method: 'POST', body: form });
  };

  it('the browser posts the file within the policy: it lands under the key, the disk sees its size', async () => {
    const disk = await make();
    const target = await disk.presignedPost('tmp/1', { maxBytes: 100, expiresIn: 60 });
    expect((await post(target, new Uint8Array(100))).status).toBeLessThan(300);
    expect(await disk.size('tmp/1')).toBe(100);
  });

  it('counter-check: one byte over content-length-range — the store refuses it, nothing lands', async () => {
    const disk = await make();
    const target = await disk.presignedPost('tmp/2', { maxBytes: 100, expiresIn: 60 });
    const response = await post(target, new Uint8Array(101));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await disk.exists('tmp/2')).toBe(false);
  });

  it('counter-check: another key than the policy names — refused', async () => {
    const disk = await make();
    const target = await disk.presignedPost('tmp/3', { maxBytes: 100, expiresIn: 60 });
    const response = await post(target, new Uint8Array(10), target.fields.key!.replace('tmp/3', 'tmp/elsewhere'));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await disk.exists('tmp/elsewhere')).toBe(false);
  });
});

describe('the memory disk receives an upload’s stream (the fake’s uploads disk)', () => {
  it('a stream cut off by the limit leaves nothing', async () => {
    const disk = new MemoryDisk({ name: 'uploads', visibility: 'private', url: undefined, temporaryUrls: NO_TEMPORARY_URLS, clock: new TestClock() });
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(10));
        controller.error(new Error('cut off'));
      },
    });
    await expect(disk.put('x', failing)).rejects.toThrow('cut off');
    disk.assertCount(0);
  });
});

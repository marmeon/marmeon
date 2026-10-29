import { randomUUID } from 'node:crypto';
import { TestClock } from '@marmeon/core/testing';
import type { StandardResult, StandardSchemaV1 } from '@marmeon/core';
import { rules as r } from '@marmeon/validation';
import { afterAll, describe, expect, it } from 'vitest';
import { ensureBucket, S3_ENDPOINT, s3Options } from './__fixtures__/disks.ts';
import { MemoryDisk } from './drivers/memory.ts';
import { S3Disk } from './drivers/s3.ts';
import { NO_TEMPORARY_URLS } from './temporary.ts';
import { formatBytes, upload, uploadFields } from './uploads/rule.ts';
import { isPlainText, sniff } from './uploads/sniff.ts';
import { RejectedUpload, TemporaryUpload } from './uploads/temporary-upload.ts';

const bytes = (...values: (number | string)[]) => new Uint8Array(values.flatMap((value) => (typeof value === 'string' ? [...value].map((c) => c.charCodeAt(0)) : [value])));
const text = (value: string) => new TextEncoder().encode(value);

describe('sniff — a file’s type by its first bytes, never by its name', () => {
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

  it('takes audio/mpeg for an ID3 tag or a valid MPEG frame header, never for text behind a byte order mark', () => {
    const mp3 = { mime: 'audio/mpeg', extension: 'mp3' };
    // MPEG-1 Layer III 128 kbit/s 44.1 kHz; MPEG-1 Layer III 320 kbit/s 48 kHz; MPEG-2 Layer III 64 kbit/s 24 kHz; MPEG-2.5 Layer III 8 kbit/s 12 kHz; MPEG-1 Layer II 192 kbit/s 44.1 kHz with CRC.
    for (const header of [[0xff, 0xfb, 0x90], [0xff, 0xfb, 0xe4], [0xff, 0xf3, 0x84], [0xff, 0xe3, 0x14], [0xff, 0xfc, 0xa0]]) expect(sniff(bytes(...header, 0, 0)), header.join()).toEqual(mp3);
    expect(sniff(bytes('ID3', 4, 0, 0, 0, 0, 0, 0))).toEqual(mp3);
    expect(sniff(bytes('ID3')).mime).toBe('audio/mpeg');
    const octet = { mime: 'application/octet-stream', extension: 'bin' };
    for (const encoded of [[0xff, 0xfe, ...'a,b\n1,2'.split('').flatMap((c) => [c.charCodeAt(0), 0])], [0xfe, 0xff, ...'a,b\n1,2'.split('').flatMap((c) => [0, c.charCodeAt(0)])]]) {
      expect(sniff(new Uint8Array(encoded))).toEqual(octet);
    }
    expect(sniff(bytes(0xff, 0xfe, 0x41, 0x00))).toEqual(octet);
    // Invalid fields behind a sync: reserved version, reserved layer, bitrate 0000 / 1111, sample rate 11.
    for (const header of [[0xff, 0xeb, 0x90], [0xff, 0xf9, 0x90], [0xff, 0xfb, 0x00], [0xff, 0xfb, 0xf0], [0xff, 0xfb, 0x9c]]) expect(sniff(bytes(...header, 0, 0)).mime, header.join()).not.toBe('audio/mpeg');
    // Too short for a header: the padding above would otherwise stand in for the missing bytes.
    expect(sniff(bytes(0xff, 0xfb)).mime).not.toBe('audio/mpeg');
    expect(sniff(bytes(0xff)).mime).not.toBe('audio/mpeg');
  });

  it('refuses UTF-16 text for an upload that must be audio/mpeg — the verified type is the sniffed one', () => {
    const mpegOnly = r.object({ track: upload({ maxBytes: 2_000_000, mime: ['audio/mpeg'] }) });
    const verifiedAs = (head: Uint8Array) => {
      const { mime, extension } = sniff(head);
      return new TemporaryUpload({ id: 'x', field: 'track', name: 't', size: head.length, mime, extension }, { disk: undefined!, key: 'x', readStart: async () => new Uint8Array(0), read: async () => new Uint8Array(0), consume: async () => true, keep: async () => true, discard: async () => true });
    };
    const check = (head: Uint8Array) => (mpegOnly['~standard'].validate({ track: verifiedAs(head) }) as { issues?: unknown[] }).issues;
    expect(check(new Uint8Array([0xff, 0xfe, 0x61, 0x00, 0x2c, 0x00]))).toHaveLength(1);
    expect(check(bytes(0xff, 0xfb, 0x90, 0))).toBeUndefined();
    expect(verifiedAs(new Uint8Array([0xff, 0xfe, 0x61, 0x00])).extension).toBe('bin');
  });

  it('recognises markup a browser would run — HTML, SVG, XML — after a BOM, whitespace and in any case', () => {
    for (const html of ['<!DOCTYPE html><p>', '﻿ \n<HTML><body>', '<script>alert(1)</script>', '<iframe src=x>', '<!-- x --><b>']) expect(sniff(text(html)).mime).toBe('text/html');
    for (const svg of ['<svg xmlns="http://www.w3.org/2000/svg">', '<?xml version="1.0"?><svg>', '  <SVG onload=alert(1)>']) expect(sniff(text(svg)).mime).toBe('image/svg+xml');
    expect(sniff(text('<?xml version="1.0"?><note/>')).mime).toBe('application/xml');
  });
});

const utf16 = (value: string, order: 'le' | 'be', mark = true) => {
  const out: number[] = mark ? (order === 'le' ? [0xff, 0xfe] : [0xfe, 0xff]) : [];
  for (const unit of [...value].map((c) => c.charCodeAt(0))) out.push(...(order === 'le' ? [unit & 0xff, unit >> 8] : [unit >> 8, unit & 0xff]));
  return new Uint8Array(out);
};
const withBom = (value: string) => new Uint8Array([0xef, 0xbb, 0xbf, ...text(value)]);
const CSV = 'name;email\nÄnne;a@example.com\n';
const MARKUP: [string, string, string][] = [
  ['HTML', '<!DOCTYPE html><html><script>alert(1)</script></html>', 'text/html'],
  ['SVG', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>', 'image/svg+xml'],
  ['XML', '<?xml version="1.0"?><note/>', 'application/xml'],
  ['SVG with a doctype', '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg onload="alert(1)"/>', 'image/svg+xml'],
  ['HTML with a public doctype', '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN"><script>alert(1)</script>', 'text/html'],
];
const encodings: [string, (value: string) => Uint8Array][] = [
  ['UTF-8', text],
  ['UTF-8 with a BOM', withBom],
  ['UTF-16LE', (value) => utf16(value, 'le')],
  ['UTF-16BE', (value) => utf16(value, 'be')],
];

describe('sniff — markup behind a byte order mark', () => {
  it.each(MARKUP.flatMap(([name, markup, mime]) => encodings.map(([encoding, encode]) => [name, encoding, encode(markup), mime] as const)))('%s in %s is recognised as markup', (_name, _encoding, head, mime) => {
    expect(sniff(head).mime).toBe(mime);
  });

  it('keeps UTF-16 text that is no markup as octet-stream', () => {
    for (const [, encode] of encodings) expect(sniff(encode(CSV)).mime).toBe('application/octet-stream');
  });
});

describe('isPlainText — no known format, no markup, no NUL', () => {
  it('takes text in UTF-8, with a BOM, in Windows-1252 and in UTF-16 with a BOM, and an empty file', () => {
    for (const [, encode] of encodings) expect(isPlainText(encode(CSV))).toBe(true);
    expect(isPlainText(new Uint8Array([0x6e, 0x61, 0x6d, 0x65, 0x3b, 0xc4, 0x0a, 0xe4, 0xfc, 0x80]))).toBe(true);
    expect(isPlainText(new Uint8Array())).toBe(true);
  });

  it('refuses markup in every encoding', () => {
    for (const [, markup] of MARKUP) for (const [, encode] of encodings) expect(isPlainText(encode(markup))).toBe(false);
  });

  it('refuses a format behind a UTF-16 byte order mark and a unit of U+0000 in it — UTF-32 included', () => {
    const behind = (...header: (number | string)[]) => bytes(0xff, 0xfe, ...header);
    for (const head of [
      behind('PK', 3, 4, 0x14, 0, 0, 0, 8, 0),
      behind('%PDF-1.7\n'),
      behind(0x7f, 'ELF', 2, 1, 1, 0, 0, 0, 0, 0),
      behind(0, 0, 0x3c, 0, 0, 0, 'h', 0, 0, 0, 't', 0, 0, 0), // UTF-32LE `<ht…`
      bytes(0xfe, 0xff, 0, 0x3c, 0, 0, 0, 0x68), // a UTF-16BE unit of zero
      withBom('%PDF-1.7\n'),
    ]) {
      expect(isPlainText(head), [...head.subarray(0, 8)].join()).toBe(false);
    }
    expect(isPlainText(utf16(CSV, 'le'))).toBe(true);
    expect(isPlainText(utf16(CSV, 'be'))).toBe(true);
  });

  it('refuses a long file whose start is blank — a browser looks further than the start that was read', () => {
    const blank = new Uint8Array(1024).fill(0x20);
    expect(isPlainText(blank, 1024)).toBe(true);
    expect(isPlainText(blank, 1025)).toBe(false);
    expect(isPlainText(utf16(' \n'.repeat(520), 'le'), 5000)).toBe(false);
    expect(isPlainText(text('a,b\n'), 5000)).toBe(true);
  });

  it('refuses a type known by its bytes and anything with a NUL but a UTF-16 byte order mark', () => {
    for (const head of [
      bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0),
      bytes('PK', 3, 4),
      text('%PDF-1.7\n'),
      bytes('ID3', 4, 0),
      bytes(0x7f, 'ELF', 2, 1, 1, 0, 0, 0),
      bytes('MZ', 0x90, 0, 3, 0, 0, 0),
      bytes(0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1),
      bytes('a,b', 0, 'c'),
      utf16(CSV, 'le', false),
      utf16(CSV, 'be', false),
    ]) {
      expect(isPlainText(head), [...head.subarray(0, 8)].join()).toBe(false);
    }
  });
});

describe('upload() — the rule of an upload field', () => {
  it('refuses a type it cannot recognise by its bytes and points to the docs for the ones it can', () => {
    for (const mime of ['image/svg+xml', 'application/octet-stream', 'text/plain']) {
      expect(() => upload({ maxBytes: 1, mime: [mime as never] })).toThrow(`upload() cannot recognise "${mime}" by its bytes — see docs/storage.md#uploads for the types it can.`);
    }
  });

  const schema = r.object({ avatar: upload({ maxBytes: 2_000_000, mime: ['image/png', 'image/jpeg'] }) });
  const parse = (rule: StandardSchemaV1, value: unknown) => rule['~standard'].validate(value) as { value?: { avatar?: unknown }; issues?: StandardResult<unknown>['issues'] };
  const verified = (mime: string, size = 10) => new TemporaryUpload({ id: 'x', field: 'avatar', name: 'a', size, mime, extension: 'png' }, { disk: undefined!, key: 'x', readStart: async () => new Uint8Array(0), read: async () => new Uint8Array(0), consume: async () => true, keep: async () => true, discard: async () => true });
  const issues = (avatar: unknown) => parse(schema, { avatar }).issues?.map((issue) => issue.message);

  it('dimensions() asks the source for no bytes when the type is no image', async () => {
    let reads = 0;
    const source = { disk: undefined!, key: 'x', readStart: async () => (reads++, new Uint8Array(0)), read: async () => new Uint8Array(0), consume: async () => true, keep: async () => true, discard: async () => true };
    const details = { id: 'x', field: 'f', name: 'n', size: 1, extension: 'bin' };
    expect(await new TemporaryUpload({ ...details, mime: 'application/pdf' }, source).dimensions()).toBeUndefined();
    expect(reads).toBe(0);
    expect(await new TemporaryUpload({ ...details, mime: 'image/png' }, source).dimensions()).toBeUndefined();
    expect(reads).toBe(1);
  });

  it('dimensions() after store() throws — the file has moved, and a silent undefined would be kept as no size', async () => {
    const disk = new MemoryDisk({ name: 'public', visibility: 'private', url: undefined, temporaryUrls: NO_TEMPORARY_URLS, clock: new TestClock() });
    const upload = verified('image/png');
    await expect(upload.store(disk)).rejects.toThrow(); // the source here has no file; the attempt counts
    await expect(upload.dimensions()).rejects.toThrow('before storing');
  });

  it('passes a verified upload of an allowed type and size — the field is the TemporaryUpload', () => {
    const upload = verified('image/png');
    expect(parse(schema, { avatar: upload }).value?.avatar).toBe(upload);
  });

  it('refuses what is not a verified upload: nothing, a token it never verified, a refused one, a file', () => {
    expect(issues(null)).toEqual(['Choose a file.']);
    expect(parse(schema, {}).issues?.map((issue) => issue.message)).toEqual(['Choose a file.']);
    expect(issues('tu_x.y')).toEqual(['The file did not arrive — choose it again.']);
    expect(issues(new RejectedUpload('expired'))).toEqual(['The upload expired — choose the file again.']);
    expect(issues(new RejectedUpload('used'))).toEqual(['This file was saved already — choose it again.']);
    expect(issues(new File(['x'], 'a.png'))).toEqual(['The file did not arrive — choose it again.']);
  });

  it('refuses a type the rule does not name — and markup always, even without `mime`', () => {
    expect(issues(verified('image/gif'))).toEqual(['This type of file is not accepted (allowed: PNG, JPG).']);
    expect(issues(verified('text/html'))).toEqual(['This type of file is not accepted (allowed: PNG, JPG).']);
    const any = r.object({ file: upload({ maxBytes: 100 }) });
    expect(parse(any, { file: verified('application/octet-stream') }).issues).toBeUndefined();
    for (const markup of ['text/html', 'image/svg+xml', 'application/xml']) expect(parse(any, { file: verified(markup) }).issues).toHaveLength(1);
  });

  it('refuses a file over maxBytes (checked again on submit)', () => {
    expect(issues(verified('image/png', 2_000_001))).toEqual(['The file may be at most 2 MB.']);
    expect([formatBytes(1536), formatBytes(999), formatBytes(2_500_000)]).toEqual(['1.5 KB', '999 bytes', '2.5 MB']);
  });

  it('is found in a body schema by path — through nullable/optional and custom(), in nested objects', () => {
    const rule = { maxBytes: 5, mime: undefined };
    const found = uploadFields(
      r.object({
        name: r.string(),
        avatar: upload({ maxBytes: 5 }).nullable(),
        cv: upload({ maxBytes: 5 }).custom(() => true),
        profile: r.object({ photo: upload({ maxBytes: 5 }).optional() }),
      }),
    );
    expect(Object.fromEntries(found)).toEqual({ avatar: rule, cv: rule, 'profile.photo': rule });
  });


  describe('with text: true', () => {
    const textual = r.object({ file: upload({ maxBytes: 5_000_000, text: true }) });
    // What the uploads service makes of a file: the type and the text verdict, both from its first bytes.
    const checked = (head: Uint8Array) => {
      const { mime, extension } = sniff(head);
      const file = new TemporaryUpload({ id: 'x', field: 'file', name: 'f', size: head.length, mime, extension, plainText: isPlainText(head) }, { disk: undefined!, key: 'x', readStart: async () => new Uint8Array(0), read: async () => new Uint8Array(0), consume: async () => true, keep: async () => true, discard: async () => true });
      return (textual['~standard'].validate({ file }) as { issues?: { message: string }[] }).issues?.map((issue) => issue.message);
    };
    const refused = ['Only a text file is accepted, such as a CSV.'];

    it('accepts a CSV in UTF-8, with a BOM, in Windows-1252 and in UTF-16 with a BOM', () => {
      for (const [, encode] of encodings) expect(checked(encode(CSV))).toBeUndefined();
      expect(checked(new Uint8Array([0x61, 0x3b, 0x62, 0x0a, 0xe4, 0x3b, 0xfc, 0x0a]))).toBeUndefined();
    });

    it('refuses HTML, SVG and XML in UTF-8, UTF-8 with a BOM, UTF-16LE and UTF-16BE', () => {
      for (const [, markup] of MARKUP) for (const [, encode] of encodings) expect(checked(encode(markup))).toEqual(refused);
    });

    it('refuses what has a signature, an executable and a NUL without a UTF-16 byte order mark', () => {
      for (const head of [bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0), bytes('PK', 3, 4), text('%PDF-1.7\n'), bytes(0xff, 0xd8, 0xff, 0xe0), bytes(0x7f, 'ELF', 2, 1, 1, 0), bytes('MZ', 0x90, 0, 3, 0), bytes('a,b', 0, 'c'), utf16(CSV, 'le', false)]) {
        expect(checked(head)).toEqual(refused);
      }
    });

    it('takes the text flag from the service, never from the name: an upload built without it is refused', () => {
      const file = new TemporaryUpload({ id: 'x', field: 'file', name: 'data.csv', size: 3, mime: 'application/octet-stream', extension: 'bin' }, { disk: undefined!, key: 'x', readStart: async () => new Uint8Array(0), read: async () => new Uint8Array(0), consume: async () => true, keep: async () => true, discard: async () => true });
      expect((textual['~standard'].validate({ file }) as { issues?: unknown[] }).issues).toHaveLength(1);
    });

    it('is a rule of its own: with mime it is a type error and throws', () => {
      // @ts-expect-error text and mime are two statements about the same thing
      expect(() => upload({ maxBytes: 1, text: true, mime: ['image/png'] })).toThrow('upload() takes text or mime, not both');
      // @ts-expect-error text is true or left out
      expect(() => upload({ maxBytes: 1, text: false })).toThrow('text: true');
    });

    it('is found by path with its mark', () => {
      expect(Object.fromEntries(uploadFields(textual))).toEqual({ file: { maxBytes: 5_000_000, mime: undefined, text: true } });
    });
  });

  const file = () => upload({ maxBytes: 5 });

  it.each([
    ['a list of files', r.object({ photos: r.array(file()) }), '`photos` holds a list of files'],
    ['a comma-separated list of files', r.object({ photos: r.list(file()) }), '`photos` holds a list of files'],
    ['a list of objects with a file', r.object({ photos: r.array(r.object({ file: file() })) }), '`photos.file` holds a list of files'],
    ['a list that is optional', r.object({ photos: r.array(file()).optional() }), '`photos` holds a list of files'],
    ['an optional object with a file', r.object({ profile: r.object({ photo: file() }).optional() }), '`profile.photo` holds a file in an optional or nullable rule'],
    ['a nullable object with a file', r.object({ profile: r.object({ photo: file() }).nullable() }), '`profile.photo` holds a file in an optional or nullable rule'],
    ['an object with a default', r.object({ profile: r.object({ photo: file().nullable() }).default({ photo: null }) }), '`profile.photo` holds a file in an optional or nullable rule'],
    ['an optional object deep in required ones', r.object({ a: r.object({ b: r.object({ c: r.object({ photo: file() }).optional() }) }) }), '`a.b.c.photo` holds'],
    ['an optional object after custom()', r.object({ profile: r.object({ photo: file() }).custom(() => true).optional() }), '`profile.photo` holds'],
    ['a union with a file', r.object({ photo: r.union([file(), r.literal('none')]) }), '`photo` holds a file in a union'],
    ['a union of objects with a file', r.object({ photo: r.union([r.object({ file: file() }), r.object({ url: r.string() })]) }), '`photo.file` holds a file in a union'],
    ['a file in conditional fields', r.object({ kind: r.in(['a', 'b']) }).when((data) => data.kind === 'b', { photo: file() }), '`photo` holds a file in fields that apply only under a condition'],
    ['a body that is a list of files', r.array(file()), 'The body holds a list of files'],
  ])('refuses %s, naming the field', (_name, schema, message) => {
    expect(() => uploadFields(schema)).toThrow(message);
    expect(() => uploadFields(schema)).toThrow('docs/storage.md#uploads');
  });

  it('keeps the supported shapes: a file of its own, optional or nullable, in required objects; lists and unions without files', () => {
    const found = uploadFields(
      r.object({
        cv: file().optional(),
        avatar: file().nullable(),
        profile: r.object({ photo: file(), nested: r.object({ scan: file().nullable() }) }),
        tags: r.array(r.string()),
        notes: r.object({ text: r.string() }).optional(),
        kind: r.union([r.literal('a'), r.literal('b')]),
      }),
    );
    expect([...found.keys()]).toEqual(['cv', 'avatar', 'profile.photo', 'profile.nested.scan']);
  });
});

/** Against the S3-compatible test container (`pnpm test:s3`): the presigned POST of an upload. */
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

  it('takes the time to send as a duration object too', async () => {
    const disk = await make();
    const target = await disk.presignedPost('tmp/4', { maxBytes: 100, expiresIn: { minutes: 15 } });
    expect((await post(target, new Uint8Array(10))).status).toBeLessThan(300);
    await expect(disk.presignedPost('tmp/5', { maxBytes: 100, expiresIn: '15m' as never })).rejects.toThrow('write `{ minutes: 15 }`');
    await expect(disk.presignedPost('tmp/6', { maxBytes: 100, expiresIn: 0.2 })).rejects.toThrow(RangeError);
    await expect(disk.presignedPost('tmp/7', { maxBytes: 100, expiresIn: 604_801 })).rejects.toThrow(RangeError);
    await expect(disk.presignedPost('tmp/8', { maxBytes: 100, expiresIn: { days: 7 } })).resolves.toHaveProperty('url');
  });

  it('one byte over content-length-range — the store refuses it, nothing lands', async () => {
    const disk = await make();
    const target = await disk.presignedPost('tmp/2', { maxBytes: 100, expiresIn: 60 });
    const response = await post(target, new Uint8Array(101));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await disk.exists('tmp/2')).toBe(false);
  });

  it('another key than the policy names — refused', async () => {
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

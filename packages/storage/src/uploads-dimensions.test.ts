import { join } from 'node:path';
import { createApplication, defineModule } from '@marmeon/core';
import { Connections, DatabaseServiceProvider, sql } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { Controller, defineRequest, HttpServiceProvider, type ContextOf } from '@marmeon/http';
import { PageSession } from '@marmeon/http/internal';
import { PAGE_HEADER, PROTOCOL_VERSION, UPLOAD_HEADER } from '@marmeon/http/protocol';
import { defineRoutes, everyone } from '@marmeon/router';
import { createHttpKernel } from '@marmeon/server';
import { rules as r } from '@marmeon/validation';
import { afterAll, describe, expect, it } from 'vitest';
import { freshDirectory, removeDirectories } from './__fixtures__/disks.ts';
import { defineStorage } from './config.ts';
import { StorageServiceProvider, UPLOADS_TABLE, upload } from './index.ts';
import { TemporaryUploads } from './uploads/service.ts';
import { TemporaryUpload } from './uploads/temporary-upload.ts';

afterAll(removeDirectories);

const text = (value: string) => [...value].map((c) => c.charCodeAt(0));
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = (n: number) => [(n >> 8) & 255, n & 255];
const bytes = (...parts: (number[] | Uint8Array)[]) => Uint8Array.from(parts.flatMap((part) => [...part]));

/** 33 bytes: the signature and an IHDR that states `width` × `height` — nothing a decoder could run on. */
const png = (width: number, height: number) => bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], be32(13), text('IHDR'), be32(width), be32(height), [8, 6, 0, 0, 0], be32(0));
/** A JPEG whose frame header sits behind `segments` APP segments of 64 KiB each. */
function jpeg(width: number, height: number, segments: number): Uint8Array {
  const padding = Array.from({ length: segments }, () => bytes([0xff, 0xe2], be16(0xffff), new Uint8Array(0xffff - 2)));
  return bytes([0xff, 0xd8], ...padding, [0xff, 0xc0, ...be16(17), 8, ...be16(height), ...be16(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1], [0xff, 0xda, 0, 2]);
}
const le16 = (n: number) => [n & 255, (n >> 8) & 255];
/** A GIF whose logical screen is 1 × 1 and whose first frame states `width` × `height`: decoders show the frame. */
const gif = (version: '87a' | '89a', width: number, height: number, at = [0, 0]) => bytes(text(`GIF${version}`), le16(1), le16(1), [0, 0, 0], [0x2c, ...le16(at[0]!), ...le16(at[1]!), ...le16(width), ...le16(height), 0, 2, 0], [0x3b]);
/** A JPEG whose frame says `width` × `height` and whose Exif segment, after the frame, names `orientation`. */
function turnedJpeg(width: number, height: number, orientation: number): Uint8Array {
  const tiff = [...text('MM'), ...be16(42), ...be32(8), ...be16(1), ...be16(0x0112), ...be16(3), ...be32(1), ...be16(orientation), 0, 0, ...be32(0)];
  const data = [...text('Exif'), 0, 0, ...tiff];
  const frame = [0xff, 0xc0, ...be16(17), 8, ...be16(height), ...be16(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return bytes([0xff, 0xd8], frame, [0xff, 0xe1, ...be16(data.length + 2), ...data], [0xff, 0xda, 0, 2]);
}
const PDF = new TextEncoder().encode('%PDF-1.7\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n');

const ran: { size: unknown }[] = [];

function form(rule: ReturnType<typeof upload>) {
  const Request = defineRequest({ schema: r.object({ photo: rule }), authorize: everyone });
  return class extends Controller {
    static request = Request;
    async handle(ctx: ContextOf<typeof Request>) {
      ran.push({ size: await ctx.body.photo.dimensions() });
      return 'saved';
    }
  };
}

const MIMES = ['image/png', 'image/jpeg'] as const;

async function boot() {
  const base = freshDirectory();
  const app = await createApplication({
    root: base,
    discover: false,
    config: [defineStorage({ default: 'uploads', disks: { uploads: { driver: 'local', root: join(base, 'uploads') } } })],
    providers: [EncryptionServiceProvider, DatabaseServiceProvider, HttpServiceProvider, StorageServiceProvider],
    modules: [
      defineModule({
        name: 'forms',
        routes: defineRoutes((Route) => {
          Route.authorize(everyone)
            .post('/pixels', form(upload({ maxBytes: 1_000_000, mime: MIMES, dimensions: { maxPixels: 1_000_000 } })))
            .name('pixels');
          Route.authorize(everyone)
            .post('/wide', form(upload({ maxBytes: 1_000_000, mime: MIMES, dimensions: { maxWidth: 100 } })))
            .name('wide');
          Route.authorize(everyone)
            .post('/animated', form(upload({ maxBytes: 1_000_000, mime: ['image/gif', 'image/webp'], dimensions: { maxPixels: 1_000_000 } })))
            .name('animated');
          Route.authorize(everyone)
            .post('/high', form(upload({ maxBytes: 1_000_000, mime: MIMES, dimensions: { maxHeight: 100 } })))
            .name('high');
        }),
      }),
    ],
  }, { env: { APP_KEY: generateKey(), LOG_LEVEL: 'silent', DB_MANAGED: 'false', DB_DRIVER: 'sqlite', DB_DATABASE: ':memory:', UPLOADS_CONNECTION: 'default' } });
  app.container.scoped(PageSession, () => ({ started: () => true, csrfToken: () => undefined, scope: () => 'a-session', generation: () => undefined, readAt: () => undefined }));
  await sql`
    create table ${sql.table(UPLOADS_TABLE)} (
      id varchar(36) primary key, session varchar(64) not null, route varchar(200) not null, field varchar(200) not null,
      disk varchar(100) not null, key varchar(255) not null, name varchar(255) not null, max_bytes bigint not null, size bigint,
      created_at bigint not null, expires_at bigint not null, started_at bigint, uploaded_at bigint, consumed_at bigint
    )
  `.execute(app.container.make(Connections).get('default'));
  const kernel = createHttpKernel(app);
  const json = { 'content-type': 'application/json', accept: 'application/json', [PAGE_HEADER]: PROTOCOL_VERSION };

  /** What `app.upload()` does: the target, then the bytes — the token the form sends. */
  async function send(path: string, contents: Uint8Array): Promise<string> {
    const target = await kernel.request(path, { method: 'POST', headers: { ...json, [UPLOAD_HEADER]: 'photo' }, body: JSON.stringify({ name: 'a.bin', size: contents.byteLength }) });
    expect(target.status).toBe(200);
    const { token, upload: where } = (await target.json()) as { token: string; upload: { url: string } };
    const put = await kernel.request(where.url, { method: 'PUT', headers: { ...json, [UPLOAD_HEADER]: 'bytes', 'content-type': 'application/octet-stream' }, body: contents });
    expect(put.status).toBe(200);
    return token;
  }
  const submit = (path: string, photo: string) => kernel.request(path, { method: 'POST', headers: json, body: JSON.stringify({ photo }) });
  return { app, send, submit };
}

/** The 422 of a submit: the status and the messages of the field. */
async function refused(answer: Response) {
  expect(answer.status).toBe(422);
  const body = (await answer.json()) as { errors: { photo?: string[] } };
  return body.errors.photo;
}

describe('upload() with dimensions: the header decides before any code decodes the file', () => {
  it('a 33-byte PNG whose header states 100000 × 100000 is refused on the field and the controller never runs', async () => {
    const { send, submit } = await boot();
    ran.length = 0;
    const token = await send('/pixels', png(100_000, 100_000));
    expect(await refused(await submit('/pixels', token))).toEqual(['The image may have at most 1000000 pixels.']);
    expect(ran).toEqual([]);
  });

  it('width, height and pixels each refuse alone, with the limit that was set', async () => {
    const { send, submit } = await boot();
    ran.length = 0;
    expect(await refused(await submit('/wide', await send('/wide', png(101, 5))))).toEqual(['The image may be at most 100 pixels wide.']);
    expect(await refused(await submit('/high', await send('/high', png(5, 101))))).toEqual(['The image may be at most 100 pixels high.']);
    expect(await refused(await submit('/pixels', await send('/pixels', png(1001, 1000))))).toEqual(['The image may have at most 1000000 pixels.']);
    expect(ran).toEqual([]);
  });

  it('a limit is inclusive: exactly maxWidth wide, maxHeight high and maxPixels in all pass', async () => {
    const { send, submit } = await boot();
    ran.length = 0;
    expect((await submit('/wide', await send('/wide', png(100, 5)))).status).toBe(200);
    expect((await submit('/high', await send('/high', png(5, 100)))).status).toBe(200);
    expect((await submit('/pixels', await send('/pixels', png(1000, 1000)))).status).toBe(200);
    expect(ran).toHaveLength(3);
  });

  it.each(['87a', '89a'] as const)('a GIF%s with a 1 × 1 screen and a 20000 × 20000 first frame is refused: the frame is what a decoder allocates', async (version) => {
    const { send, submit } = await boot();
    ran.length = 0;
    expect(await refused(await submit('/animated', await send('/animated', gif(version, 20_000, 20_000))))).toEqual(['The image may have at most 1000000 pixels.']);
    expect(ran).toEqual([]);
    expect((await submit('/animated', await send('/animated', gif(version, 10, 10)))).status).toBe(200);
  });

  it('a GIF whose first frame is 1 × 1 and whose second is 2000 × 2000 is refused: a decoder that reads every frame allocates it', async () => {
    const { send, submit } = await boot();
    ran.length = 0;
    const frame = (width: number) => [0x2c, 0, 0, 0, 0, ...le16(width), ...le16(width), 0, 2, 3, 1, 2, 3, 0];
    const file = bytes(text('GIF89a'), le16(1), le16(1), [0, 0, 0], frame(1), frame(2000), [0x3b]);
    expect(await refused(await submit('/animated', await send('/animated', file)))).toEqual(['The image may have at most 1000000 pixels.']);
    expect(ran).toEqual([]);
  });

  it('a GIF with a 1 × 1 first frame placed at 20000, 20000 is refused: the canvas reaches its far edge', async () => {
    const { send, submit } = await boot();
    ran.length = 0;
    expect(await refused(await submit('/animated', await send('/animated', gif('89a', 1, 1, [20_000, 20_000]))))).toEqual(['The image may have at most 1000000 pixels.']);
    expect(ran).toEqual([]);
  });

  it('a JPEG stored 10 × 200 whose Exif turns it a quarter shows 200 × 10: maxWidth sees the turned size', async () => {
    const { send, submit } = await boot();
    ran.length = 0;
    expect(await refused(await submit('/wide', await send('/wide', turnedJpeg(10, 200, 6))))).toEqual(['The image may be at most 100 pixels wide.']);
    expect(ran).toEqual([]);
    expect((await submit('/wide', await send('/wide', turnedJpeg(10, 200, 1)))).status).toBe(200);
  });

  it('an image inside the limits passes, and dimensions() still works for the controller afterwards', async () => {
    const { send, submit } = await boot();
    ran.length = 0;
    const answer = await submit('/pixels', await send('/pixels', png(1000, 1000)));
    expect(answer.status).toBe(200);
    expect(await answer.text()).toBe('saved');
    expect(ran).toEqual([{ size: { width: 1000, height: 1000 } }]);
  });

  it('a JPEG whose frame header lies beyond the bytes the hook reads is refused as unreadable — never let through', async () => {
    const { send, submit } = await boot();
    ran.length = 0;
    expect(await refused(await submit('/pixels', await send('/pixels', jpeg(10, 10, 5))))).toEqual(['The size of this image cannot be read — save it again as PNG, JPG.']);
    expect(ran).toEqual([]);
    // The same file with the header up front is fine: only the position made it unreadable.
    expect((await submit('/pixels', await send('/pixels', jpeg(10, 10, 0)))).status).toBe(200);
  });

  it('a PDF sent to an image field is refused by type — not measured, not let through', async () => {
    const { send, submit } = await boot();
    ran.length = 0;
    expect(await refused(await submit('/wide', await send('/wide', PDF)))).toEqual(['This type of file is not accepted (allowed: PNG, JPG).']);
    expect(ran).toEqual([]);
  });

  it('validate() on an upload the hook never measured is refused as unreadable', async () => {
    const { app, send } = await boot();
    const token = await send('/pixels', png(1, 1));
    const found = await app.container.make(TemporaryUploads).resolve(token, { session: 'a-session', route: 'pixels', field: 'photo' });
    expect(found).toBeInstanceOf(TemporaryUpload);
    const schema = r.object({ photo: upload({ maxBytes: 1_000_000, mime: MIMES, dimensions: { maxPixels: 1_000_000 } }) });
    const result = await schema['~standard'].validate({ photo: found });
    expect(result.issues?.map((issue) => issue.message)).toEqual(['The size of this image cannot be read — save it again as PNG, JPG.']);
  });
});

describe('upload() with dimensions: a definition that cannot measure refuses at the start', () => {
  const bad = (options: unknown) => () => upload(options as never);

  it('mime missing, a type with no pixel size, text, no limit, a limit that is no positive integer, a limit it does not know', () => {
    // @ts-expect-error — dimensions needs mime: any type would let a file through unmeasured
    expect(() => upload({ maxBytes: 1000, dimensions: { maxPixels: 10 } })).toThrow(TypeError);
    // @ts-expect-error — an AVIF header holds the container's size, which a decoder need not follow
    expect(() => upload({ maxBytes: 1000, mime: ['image/avif'], dimensions: { maxPixels: 10 } })).toThrow('cannot check the pixel size of "image/avif"');
    // @ts-expect-error — a PDF has no pixel size to check
    expect(() => upload({ maxBytes: 1000, mime: ['application/pdf'], dimensions: { maxPixels: 10 } })).toThrow('cannot check the pixel size of "application/pdf"');
    // @ts-expect-error — text and dimensions are two statements about the same file
    expect(() => upload({ maxBytes: 1000, text: true, dimensions: { maxPixels: 10 } })).toThrow(TypeError);
    // @ts-expect-error — at least one limit
    expect(() => upload({ maxBytes: 1000, mime: ['image/png'], dimensions: {} })).toThrow(RangeError);
    expect(() => upload({ maxBytes: 1000, mime: ['image/png'], dimensions: { maxPixels: 0 } })).toThrow(RangeError);
    expect(() => upload({ maxBytes: 1000, mime: ['image/png'], dimensions: { maxWidth: 1.5 } })).toThrow(RangeError);
    expect(bad({ maxBytes: 1000, mime: ['image/png'], dimensions: { maxWidth: 10, maxPixel: 5 } })).toThrow('does not know the dimensions limit "maxPixel"');
    expect(bad({ maxBytes: 1000, mime: ['image/png'], dimensions: 'big' })).toThrow(TypeError);
    // A typo of the option itself, or options built in a variable, never drops a limit silently.
    expect(bad({ maxBytes: 1000, mime: ['image/png'], dimension: { maxPixels: 10 } })).toThrow('does not know the option "dimension"');
    expect(bad({ maxBytes: 1000, mim: ['image/png'] })).toThrow('does not know the option "mim"');
  });
});

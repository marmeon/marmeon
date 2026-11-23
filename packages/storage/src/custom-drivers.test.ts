import { Clock, createApplication } from '@marmeon/core';
import { TestClock } from '@marmeon/core/testing';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider, UrlSigner } from '@marmeon/http';
import { createHttpKernel } from '@marmeon/server';
import { afterAll, describe, expect, it } from 'vitest';
import { freshDirectory, removeDirectories } from './__fixtures__/disks.ts';
import { defineStorage, type DiskDriverFactory } from './config.ts';
import type { Disk, DiskDriver, DiskDriverTemporaryUrlOptions, OpenedFile } from './disk.ts';
import { MemoryDisk } from './drivers/memory.ts';
import { StorageFake } from './fake.ts';
import { InvalidKeyError, Storage, StorageError, StorageServiceProvider, StorageSetupError } from './index.ts';
import { servedPublicDisks } from './routes.ts';
import { serveFile } from './serve.ts';

declare module './config.ts' {
  interface DiskDrivers {
    crate: { readonly bucket: string };
  }
}

afterAll(removeDirectories);

const signed = { sign: (disk: string, key: string) => `/signed/${disk}/${key}?signature=x` };
const memory = (name: string, visibility: 'public' | 'private' = 'private', url?: string) =>
  new MemoryDisk({ name, visibility, url, temporaryUrls: signed, clock: new TestClock() });

/** The memory disk as a driver sees the contract: `temporaryUrl()` gets whole seconds. */
const asDriver = (disk: MemoryDisk, seen: DiskDriverTemporaryUrlOptions[] = []): DiskDriver =>
  new Proxy(disk, {
    get(target, property) {
      if (property === 'temporaryUrl') {
        return (key: string, options: DiskDriverTemporaryUrlOptions) => {
          seen.push(options);
          const { expiresInSeconds, ...rest } = options;
          return target.temporaryUrl(key, { expiresIn: expiresInSeconds, ...rest });
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as DiskDriver;

/** A driver backed by a memory disk — the contract in its smallest form. */
const crate: DiskDriverFactory<{ visibility?: 'public' | 'private'; url?: string }> = (options, { name }) =>
  asDriver(memory(name, options.visibility ?? 'private', options.url));

function boot(storage: ReturnType<typeof defineStorage>, providers: readonly object[], options: { fake?: boolean } = {}) {
  return createApplication(
    { root: freshDirectory(), discover: false, config: [storage], providers: [StorageServiceProvider, ...providers] as never },
    {
      env: { LOG_LEVEL: 'silent' },
      override: (container) => {
        container.instance(Clock, new TestClock());
        if (options.fake) container.instance(Storage, new StorageFake(container));
      },
    },
  );
}

const disks = (extra: Record<string, object> = {}) => defineStorage({ default: 'media', disks: { media: { driver: 'crate', bucket: 'files' }, ...extra } as never });

class Crate {
  static diskDrivers = { crate };
}

/** A provider whose `crate` driver is `factory`. */
const providing = (factory: unknown) =>
  class {
    static diskDrivers = { crate: factory as DiskDriverFactory };
  };

describe('disk drivers of providers', () => {
  it('a disk with a registered driver works, and gets its options, name, root and the container', async () => {
    let seen: unknown;
    const app = await boot(disks(), [
      providing((options: never, context: Parameters<DiskDriverFactory>[1]) => {
        seen = { options, name: context.name, root: context.root, container: context.container };
        return crate(options, context);
      }),
    ]);
    const disk = app.container.make(Storage).disk('media');
    await disk.put('a.txt', 'hi');
    expect(await disk.text('a.txt')).toBe('hi');
    expect(seen).toMatchObject({ options: { driver: 'crate', bucket: 'files' }, name: 'media', root: app.root, container: app.container });
  });

  it('a driver-only provider is a valid provider', async () => {
    await expect(boot(disks(), [Crate])).resolves.toBeDefined();
  });

  it('negative: an unknown driver stops the start with the disk and the known drivers', async () => {
    await expect(boot(disks({ other: { driver: 'gcs' } }), [Crate])).rejects.toThrow(/disk "other" has an unknown driver "gcs" — the drivers: local, s3, memory, crate/);
    await expect(boot(disks(), [])).rejects.toThrow(/disk "media" has an unknown driver "crate"/);
  });

  it('negative: a provider cannot take a built-in name, two providers one name, or a malformed name', async () => {
    const take = (name: string) =>
      class Taker {
        static diskDrivers = { [name]: crate };
      };
    await expect(boot(disks(), [Crate, take('local')])).rejects.toThrow(/named "local".*built-in/);
    await expect(boot(disks(), [Crate, take('s3')])).rejects.toThrow(/named "s3"/);
    await expect(boot(disks(), [Crate, take('memory')])).rejects.toThrow(/named "memory"/);
    await expect(
      boot(disks(), [
        Crate,
        class Other {
          static diskDrivers = { crate };
        },
      ]),
    ).rejects.toThrow(/"crate" is brought by both Crate and Other/);
    await expect(boot(disks(), [Crate, take('../x')])).rejects.toThrow(/lowercase letters/);
  });

  it('negative: a driver that returns no disk, or half of one, stops the start', async () => {
    await expect(boot(disks(), [providing(() => ({ name: 'media', visibility: 'private' }))])).rejects.toThrow(/missing: put, get/);
    await expect(boot(disks(), [providing(() => undefined)])).rejects.toThrow(/must return a DiskDriver/);
  });

  it('a factory that fails stops the start with its error', async () => {
    await expect(
      boot(disks(), [
        providing(() => {
          throw new Error('no credentials');
        }),
      ]),
    ).rejects.toThrow('no credentials');
  });

  it('negative: a disk named or marked differently than configured stops the start', async () => {
    await expect(boot(disks(), [providing(() => memory('other'))])).rejects.toThrow('returned a disk named "other"');
    await expect(boot(disks(), [providing((_: unknown, { name }: { name: string }) => memory(name, 'public', '/x'))])).rejects.toThrow(
      'is private in the configuration, but its driver returned a public disk',
    );
  });

  it('negative: url() on a private disk fails although the driver could answer one', async () => {
    const leaky = providing((_: unknown, { name }: { name: string }) => Object.assign(Object.create(memory(name)) as Disk, { url: (key: string) => `https://cdn.example/${key}` }));
    const app = await boot(disks(), [leaky]);
    const disk = app.container.make(Storage).disk('media') as unknown as Disk;
    expect(() => disk.url('secret.txt')).toThrow(StorageError);
    expect(() => disk.url('secret.txt')).toThrow(/private/);
  });

  it('negative: an empty temporaryUrl() of a driver is refused; the driver\'s url() is never called on a private disk', async () => {
    let urlCalls = 0;
    const empty = providing((_: unknown, { name }: { name: string }) =>
      Object.assign(Object.create(memory(name)) as Disk, {
        url: () => (urlCalls++, 'https://cdn.example/x'),
        temporaryUrl: async () => '',
      }),
    );
    const bad = (await boot(disks(), [empty])).container.make(Storage).disk('media') as unknown as Disk;
    await expect(bad.temporaryUrl('a.txt', { expiresIn: 60 })).rejects.toThrow(/returned no URL/);
    expect(() => bad.url('a.txt')).toThrow(/private/);
    expect(urlCalls).toBe(0);
    const good = (await boot(disks(), [Crate])).container.make(Storage).disk('media') as unknown as Disk;
    await expect(good.temporaryUrl('a.txt', { expiresIn: 60 })).resolves.toBe('/signed/media/a.txt?signature=x');
  });

  it('hands a driver whole seconds, whatever span the app wrote', async () => {
    const seen: DiskDriverTemporaryUrlOptions[] = [];
    const watching = providing((_: unknown, { name }: { name: string }) => asDriver(memory(name), seen));
    const disk = (await boot(disks(), [watching])).container.make(Storage).disk('media') as unknown as Disk;
    await disk.temporaryUrl('a.txt', { expiresIn: { minutes: 5 }, filename: 'x.txt' });
    await disk.temporaryUrl('a.txt', { expiresIn: 90 });
    await disk.temporaryUrl('a.txt', { expiresIn: { seconds: 1, milliseconds: 900 } });
    expect(seen).toEqual([{ expiresInSeconds: 300, filename: 'x.txt' }, { expiresInSeconds: 90 }, { expiresInSeconds: 1 }]);
    await expect(disk.temporaryUrl('a.txt', { expiresIn: { milliseconds: 500 } })).rejects.toThrow(RangeError);
    await expect(disk.temporaryUrl('a.txt', { expiresIn: '5m' as never })).rejects.toThrow('write `{ minutes: 5 }`');
    expect(seen).toHaveLength(3);
  });

  it('never hands a driver more than seven days', async () => {
    const seen: DiskDriverTemporaryUrlOptions[] = [];
    const watching = providing((_: unknown, { name }: { name: string }) => asDriver(memory(name), seen));
    const disk = (await boot(disks(), [watching])).container.make(Storage).disk('media') as unknown as Disk;
    await disk.temporaryUrl('a.txt', { expiresIn: { days: 7 } });
    await expect(disk.temporaryUrl('a.txt', { expiresIn: 604_801 })).rejects.toThrow(RangeError);
    await expect(disk.temporaryUrl('a.txt', { expiresIn: { days: 8 } })).rejects.toThrow('at most 7 days');
    expect(seen).toEqual([{ expiresInSeconds: 604_800 }]);
  });

  it('a public disk of a driver keeps its url()', async () => {
    const app = await boot(disks({ cdn: { driver: 'crate', bucket: 'x', visibility: 'public', url: 'https://cdn.example' } }), [Crate]);
    expect((app.container.make(Storage).disk('cdn') as unknown as Disk).url('a.png')).toBe('https://cdn.example/a.png');
  });

  it('negative: a private disk with a url is refused for a provider driver too', async () => {
    await expect(boot(disks({ x: { driver: 'crate', bucket: 'x', url: 'https://cdn.example' } }), [Crate])).rejects.toThrow('is private but has a url');
  });

  it('the fake replaces a custom disk by memory, and still refuses an unknown driver', async () => {
    const app = await boot(disks(), [Crate], { fake: true });
    const disk = app.container.make(Storage).disk('media') as unknown as MemoryDisk;
    await disk.put('a.txt', 'x');
    disk.assertExists('a.txt');
    await expect(boot(disks(), [], { fake: true })).rejects.toThrow(StorageSetupError);
    await expect(boot(disks(), [], { fake: true })).rejects.toThrow('[marmeon:S2] ');
  });

  it('negative: a key the framework refuses never reaches the driver — for every member, both keys of move/copy, and list()', async () => {
    const calls: unknown[][] = [];
    const spy = providing((_: unknown, { name }: { name: string }) => {
      const inner = memory(name, name === 'open' ? 'public' : 'private', name === 'open' ? 'https://cdn.example' : undefined);
      return new Proxy(inner, { get: (target, member) => (typeof member === 'string' && typeof (target as never)[member] === 'function' ? (...args: unknown[]) => (calls.push([member, ...args]), (target as never as Record<string, (...a: unknown[]) => unknown>)[member]!(...args)) : (target as never)[member]) });
    });
    const app = await boot(disks({ open: { driver: 'crate', bucket: 'x', visibility: 'public' } }), [spy]);
    const disk = app.container.make(Storage).disk('open') as unknown as Disk;
    for (const key of ['../x', 'a/./b', 'a//b', 'a\u0007b', '/abs', '']) {
      for (const call of [
        () => disk.put(key, 'x'),
        () => disk.get(key),
        () => disk.text(key),
        () => disk.stream(key),
        () => disk.open(key),
        () => disk.exists(key),
        () => disk.delete(key),
        () => disk.move(key, 'ok'),
        () => disk.move('ok', key),
        () => disk.copy(key, 'ok'),
        () => disk.copy('ok', key),
        () => disk.size(key),
        () => disk.mimeType(key),
        () => disk.lastModified(key),
        // '' is the root for list()
        () => (key === '' ? Promise.reject(new Error('Invalid storage key')) : disk.list(key)),
        () => Promise.resolve().then(() => disk.url(key)),
        () => disk.temporaryUrl(key, { expiresIn: 60 }),
      ]) {
        await expect(call(), key).rejects.toThrow(/Invalid storage key/);
      }
    }
    expect(calls.filter(([member]) => member !== 'name')).toEqual([]);
    await disk.put('ok', 'fine');
    expect(await disk.list('')).toEqual(['ok']);
  });

  it('a frozen disk object works, and the app\'s disk reports the configured name and visibility', async () => {
    const frozen = providing((_: unknown, { name }: { name: string }) => {
      const inner = memory(name);
      const members = ['put', 'get', 'text', 'stream', 'open', 'exists', 'delete', 'move', 'copy', 'size', 'mimeType', 'lastModified', 'list', 'url', 'temporaryUrl'] as const;
      return Object.freeze({ name, visibility: 'private', ...Object.fromEntries(members.map((member) => [member, (inner[member] as (...args: unknown[]) => unknown).bind(inner)])) });
    });
    const app = await boot(disks(), [frozen]);
    const disk = app.container.make(Storage).disk('media') as unknown as Disk;
    await disk.put('a.txt', 'x');
    expect(disk.put).toBe(disk.put);
    expect(disk.name).toBe('media');
    expect(disk.visibility).toBe('private');
  });

  it('negative: assigning visibility or name on the app\'s disk changes nothing and never unlocks url()', async () => {
    const leaky = providing((_: unknown, { name }: { name: string }) => Object.assign(Object.create(memory(name)) as Disk, { url: () => 'https://cdn.example/x' }));
    const disk = (await boot(disks(), [leaky])).container.make(Storage).disk('media') as unknown as { visibility: string; name: string; url(key: string): string };
    try {
      disk.visibility = 'public';
      disk.name = 'other';
    } catch {
      // a setter-less accessor throws in strict mode: also fine
    }
    expect(disk.visibility).toBe('private');
    expect(disk.name).toBe('media');
    expect(() => disk.url('a.txt')).toThrow(/private/);
  });

  it('close() of a driver\'s disk runs when the app shuts down', async () => {
    let closed = 0;
    const closing = providing((_: unknown, { name }: { name: string }) => Object.assign(Object.create(memory(name)) as Disk, { close: async () => void closed++ }));
    const app = await boot(disks(), [closing]);
    await app.shutdown();
    expect(closed).toBe(1);
  });

  it('negative: a validly signed request for a provider driver’s disk gets 404, the driver is never asked', async () => {
    let reads = 0;
    const reading = providing((_: unknown, { name }: { name: string }) => {
      const inner = memory(name);
      return Object.assign(Object.create(inner) as Disk, { open: async () => (reads++, inner.open('a.txt')) });
    });
    const app = await createApplication(
      { root: freshDirectory(), discover: false, config: [disks()], providers: [EncryptionServiceProvider, HttpServiceProvider, StorageServiceProvider, reading] as never },
      { env: { APP_KEY: generateKey(), LOG_LEVEL: 'silent' } },
    );
    const url = app.container.make(UrlSigner).signedPath('/_marmeon/storage/media/a.txt', { expiresIn: 60 });
    const response = await createHttpKernel(app).request(url);
    expect(response.status).toBe(404);
    expect(reads).toBe(0);
  });

  it('the app serves no route for a provider driver’s disk: its url is its own', () => {
    const options = { default: 'a', disks: { a: { driver: 'crate', bucket: 'b', visibility: 'public', url: '/files' } } };
    expect(servedPublicDisks(options as never)).toEqual([]);
  });
});

describe('open() with a range on the disk of a driver', () => {
  /** A driver whose `open` is `open(inner, ...args)`, the rest of it the memory disk's. */
  const opening = (open: (inner: MemoryDisk, ...args: unknown[]) => Promise<OpenedFile>, acceptsRanges = false) =>
    providing((_: unknown, { name }: { name: string }) => {
      const inner = memory(name);
      return new Proxy(asDriver(inner), {
        get: (target, property) => {
          if (property === 'acceptsRanges') return acceptsRanges ? true : undefined;
          return property === 'open' ? (...args: unknown[]) => open(inner, ...args) : Reflect.get(target, property);
        },
      });
    });
  const diskOf = async (provider: object) => {
    const disk = (await boot(disks(), [provider])).container.make(Storage).disk('media') as unknown as Disk;
    await disk.put('digits.txt', '0123456789');
    return disk;
  };
  const text = async (file: OpenedFile) => new Response(file.body).text();

  it('a driver written before ranges is called with the key alone, and answers the whole file when a range is asked', async () => {
    const calls: unknown[][] = [];
    const disk = await diskOf(opening(async (inner, ...args) => (calls.push(args), inner.open(args[0] as string))));
    expect(await text(await disk.open('digits.txt'))).toBe('0123456789');
    expect(calls).toEqual([['digits.txt']]); // exactly one argument
    const whole = await disk.open('digits.txt', { range: { start: 3, end: 4 } });
    expect([await text(whole), whole.range]).toEqual(['0123456789', undefined]);
    expect(calls[1]).toEqual(['digits.txt']); // asked, but the driver did not opt in: still the key alone
  });

  it('a driver with a second parameter of its own is never given the range unless it opts in', async () => {
    const seen: unknown[][] = [];
    const flagged = (acceptsRanges: boolean) =>
      opening(async (inner, key, flag = false) => (seen.push([key, flag]), flag ? { ...(await inner.open(key as string)), contentType: 'x/flagged' } : inner.open(key as string)), acceptsRanges);
    const plain = await diskOf(flagged(false));
    const file = await plain.open('digits.txt', { range: { start: 1 } });
    expect([file.contentType, file.range, await text(file)]).toEqual(['text/plain', undefined, '0123456789']);
    expect(seen).toEqual([['digits.txt', false]]);
    seen.length = 0;
    const opted = await diskOf(flagged(true));
    expect((await opted.open('digits.txt', { range: { start: 1 } })).contentType).toBe('x/flagged');
    expect(seen).toEqual([['digits.txt', { range: { start: 1 } }]]);
  });

  it('serveFile with ranges: true on a driver that did not opt in: 200, the whole file, no Accept-Ranges, the driver sees the key alone', async () => {
    const seen: unknown[][] = [];
    const flagged = opening(async (inner, key, flag = false) => (seen.push([key, flag]), flag ? { ...(await inner.open(key as string)), contentType: 'x/flagged' } : inner.open(key as string)));
    const disk = await diskOf(flagged);
    const request = new Request('http://localhost/a', { headers: { range: 'bytes=2-4' } });
    const response = await serveFile(disk, 'digits.txt', request, { cacheControl: 'private', ranges: true });
    expect([response.status, response.headers.get('accept-ranges'), response.headers.get('content-range'), response.headers.get('content-length'), await response.text()]).toEqual([200, null, null, '10', '0123456789']);
    expect(seen).toEqual([['digits.txt', false]]);
  });

  it('serveFile with ranges: true on a driver that opted in: 206 with the slice and Accept-Ranges', async () => {
    const disk = await diskOf(opening((inner, ...args) => inner.open(args[0] as string, args[1] as never), true));
    const request = new Request('http://localhost/a', { headers: { range: 'bytes=2-4' } });
    const response = await serveFile(disk, 'digits.txt', request, { cacheControl: 'private', ranges: true });
    expect([response.status, response.headers.get('accept-ranges'), response.headers.get('content-range'), await response.text()]).toEqual([206, 'bytes', 'bytes 2-4/10', '234']);
  });

  it('a driver that did not opt in has a range it made up dropped when one was asked', async () => {
    const disk = await diskOf(opening(async (inner, key) => ({ ...(await inner.open(key as string)), range: { start: 1, end: 2 } })));
    const file = await disk.open('digits.txt', { range: { start: 1, end: 2 } });
    expect([file.range, await text(file)]).toEqual([undefined, '0123456789']);
  });

  it('a driver that did not opt in and whose range and acceptsRanges show up only on a later read: the result never shows them', async () => {
    let rangeReads = 0;
    let claimReads = 0;
    const disk = await diskOf(
      opening(async (inner, key) => {
        const file = await inner.open(key as string);
        return Object.defineProperties({}, {
          body: { value: file.body, enumerable: true },
          size: { value: file.size, enumerable: true },
          lastModified: { value: file.lastModified, enumerable: true },
          contentType: { value: file.contentType, enumerable: true },
          range: { get: () => (rangeReads++ === 0 ? undefined : { start: 2, end: 4 }), enumerable: true },
          acceptsRanges: { get: () => (claimReads++ === 0 ? undefined : true), enumerable: true },
        }) as OpenedFile;
      }),
    );
    const file = await disk.open('digits.txt', { range: { start: 2, end: 4 } });
    expect([file.range, file.range, file.acceptsRanges, file.acceptsRanges, await text(file)]).toEqual([undefined, undefined, undefined, undefined, '0123456789']);
  });

  it('the answer of an opted-in driver is read once: a getter that changes afterwards does not matter', async () => {
    let sizeReads = 0;
    let rangeReads = 0;
    const disk = await diskOf(
      opening(async (inner, key) => {
        const file = await inner.open(key as string);
        return Object.defineProperties({}, {
          body: { value: file.body, enumerable: true },
          size: { get: () => (sizeReads++ === 0 ? 10 : 3), enumerable: true },
          lastModified: { value: file.lastModified, enumerable: true },
          contentType: { value: file.contentType, enumerable: true },
          range: { get: () => (rangeReads++ === 0 ? { start: 2, end: 4 } : 'unsatisfiable'), enumerable: true },
        }) as OpenedFile;
      }, true),
    );
    const file = await disk.open('digits.txt', { range: { start: 2, end: 4 } });
    expect([file.size, file.range, file.size, file.range]).toEqual([10, { start: 2, end: 4 }, 10, { start: 2, end: 4 }]);
  });

  it('the answer of an opted-in driver without a range is read once too: a range that shows up later is not seen', async () => {
    let rangeReads = 0;
    const disk = await diskOf(
      opening(async (inner, key) => {
        const file = await inner.open(key as string);
        return Object.defineProperties({}, {
          body: { value: file.body, enumerable: true },
          size: { value: file.size, enumerable: true },
          lastModified: { value: file.lastModified, enumerable: true },
          contentType: { value: file.contentType, enumerable: true },
          range: { get: () => (rangeReads++ === 0 ? undefined : { start: 0, end: 9 }), enumerable: true },
        }) as OpenedFile;
      }, true),
    );
    const file = await disk.open('digits.txt', { range: { start: 0 } });
    expect([file.range, file.range, await text(file)]).toEqual([undefined, undefined, '0123456789']);
  });

  it('acceptsRanges is the framework\'s: not opted in it is never on the result, opted in it always is', async () => {
    const plain = await diskOf(opening(async (inner, key) => inner.open(key as string))); // the memory disk's result says true
    expect((await plain.open('digits.txt')).acceptsRanges).toBeUndefined();
    expect((await plain.open('digits.txt', { range: { start: 1 } })).acceptsRanges).toBeUndefined();
    const silent = await diskOf(
      opening(async (inner, key) => {
        const { acceptsRanges: _dropped, ...file } = await inner.open(key as string);
        return file;
      }, true),
    );
    expect((await silent.open('digits.txt')).acceptsRanges).toBe(true);
    expect((await silent.open('digits.txt', { range: { start: 1 } })).acceptsRanges).toBe(true);
  });

  it('a driver that did not opt in and returns a class instance with getters and a made-up range: its fields are kept, the range dropped', async () => {
    const lastModified = new Date(5000);
    class Answer {
      get body() {
        return new Response('whole').body!;
      }
      get size() {
        return 5;
      }
      get lastModified() {
        return lastModified;
      }
      get contentType() {
        return 'text/plain';
      }
      get range() {
        return { start: 1, end: 2 };
      }
    }
    const disk = await diskOf(opening(async () => new Answer() as unknown as OpenedFile));
    const file = await disk.open('digits.txt', { range: { start: 1 } });
    expect([file.size, file.lastModified, file.contentType, file.range, await text(file)]).toEqual([5, lastModified, 'text/plain', undefined, 'whole']);
  });

  it('a driver that honours the range is given a copy of the checked range, and its answer passes', async () => {
    const seen: unknown[] = [];
    const asked = { start: 2, end: 4 };
    const disk = await diskOf(opening(async (inner, key, options) => (seen.push(options), inner.open(key as string, options as never)), true));
    const file = await disk.open('digits.txt', { range: asked });
    expect([await text(file), file.range]).toEqual(['234', { start: 2, end: 4 }]);
    expect(seen).toEqual([{ range: { start: 2, end: 4 } }]);
    expect((seen[0] as { range: unknown }).range).not.toBe(asked);
  });

  it('negative: an answer that is not the requested bytes is refused, its body cancelled', async () => {
    const wrongAnswers: (OpenedFile['range'])[] = [{ start: 0, end: 5 }, { start: 3, end: 4 }, { start: 2, end: 9 }, 'unsatisfiable'];
    for (const range of wrongAnswers) {
      let cancelled = 0;
      const disk = await diskOf(
        opening(async (inner, key) => ({
          ...(await inner.open(key as string)),
          body: new ReadableStream<Uint8Array>({ cancel: () => void cancelled++ }),
          range,
        }), true),
      );
      await expect(disk.open('digits.txt', { range: { start: 2, end: 4 } }), JSON.stringify(range)).rejects.toThrow(StorageError);
      expect(cancelled).toBe(1);
    }
  });

  it('negative: a range that cannot be answered is refused whatever a driver says, for an unsatisfiable one too', async () => {
    const disk = await diskOf(opening(async (inner, key) => ({ ...(await inner.open(key as string)), range: { start: 0, end: 9 } }), true));
    await expect(disk.open('digits.txt', { range: { start: 10 } })).rejects.toThrow(StorageError);
    await expect(disk.open('digits.txt', { range: { last: 0 } })).rejects.toThrow(StorageError);
  });

  it('negative: a range of the caller that is not whole never reaches the driver', async () => {
    let calls = 0;
    const disk = await diskOf(opening(async (inner, key) => (calls++, inner.open(key as string)), true));
    for (const range of [{ start: -1 }, { start: 3, end: 2 }, { start: 0, last: 1 }, { last: 0.5 }, { first: 1 }, { start: 0, length: 4 }, { start: 0, End: 4 }, { last: 1, extra: true }]) {
      await expect(disk.open('digits.txt', { range } as never)).rejects.toThrow(RangeError);
    }
    expect(calls).toBe(0);
  });

  it('negative: a key is checked before the driver sees it, with a range too', async () => {
    let calls = 0;
    const disk = await diskOf(opening(async (inner, key) => (calls++, inner.open(key as string)), true));
    await expect(disk.open('../x', { range: { start: 0 } })).rejects.toThrow(InvalidKeyError);
    expect(calls).toBe(0);
  });

  it('a range field nobody asked for is not passed on', async () => {
    const disk = await diskOf(opening(async (inner, key) => ({ ...(await inner.open(key as string)), range: { start: 1, end: 2 } })));
    const file = await disk.open('digits.txt');
    expect([file.range, await text(file)]).toEqual([undefined, '0123456789']);
    expect((await disk.open('digits.txt', {})).range).toBeUndefined();
  });

  // Guards the design (an optional argument, not a new method), not one change of it.
  it('a wrapper written before ranges that overrides open(key) is not bypassed: it serves what it changes, whole', async () => {
    const wrapper = providing((_: unknown, { name }: { name: string }) => {
      const inner = asDriver(memory(name));
      return new Proxy(inner, {
        get(target, property) {
          if (property !== 'open') return Reflect.get(target, property);
          return async (key: string) => {
            const file = await target.open(key);
            return { ...file, body: new Response((await new Response(file.body).text()).replace(/\d/g, '#')).body! };
          };
        },
      });
    });
    const disk = await diskOf(wrapper);
    expect(await text(await disk.open('digits.txt'))).toBe('##########');
    const ranged = await disk.open('digits.txt', { range: { start: 2, end: 4 } });
    expect([await text(ranged), ranged.range]).toEqual(['##########', undefined]);
  });

  it('the storage fake opens a range of its memory disks', async () => {
    const app = await boot(disks(), [Crate], { fake: true });
    const disk = app.container.make(Storage).disk('media') as unknown as Disk;
    await disk.put('digits.txt', '0123456789');
    const file = await disk.open('digits.txt', { range: { last: 3 } });
    expect([await text(file), file.range]).toEqual(['789', { start: 7, end: 9 }]);
  });
});

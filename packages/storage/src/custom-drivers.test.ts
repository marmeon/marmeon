import { Clock, createApplication } from '@marmeon/core';
import { TestClock } from '@marmeon/core/testing';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider, UrlSigner } from '@marmeon/http';
import { createHttpKernel } from '@marmeon/server';
import { afterAll, describe, expect, it } from 'vitest';
import { freshDirectory, removeDirectories } from './__fixtures__/disks.ts';
import { defineStorage, type DiskDriverFactory } from './config.ts';
import type { Disk, DiskDriver, DiskDriverTemporaryUrlOptions } from './disk.ts';
import { MemoryDisk } from './drivers/memory.ts';
import { StorageFake } from './fake.ts';
import { Storage, StorageError, StorageServiceProvider, StorageSetupError } from './index.ts';
import { servedPublicDisks } from './routes.ts';

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

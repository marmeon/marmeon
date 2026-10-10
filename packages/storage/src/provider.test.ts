import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Clock, createApplication, env, TestClock, type ConfigDefinition } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import { createHttpKernel } from '@marmeon/server';
import { afterAll, describe, expect, it } from 'vitest';
import { freshDirectory, removeDirectories } from './__fixtures__/disks.ts';
import { defineStorage } from './config.ts';
import { MemoryDisk } from './drivers/memory.ts';
import { StorageFake } from './fake.ts';
import { diskAttachment, Storage, StorageError, StorageManager, StorageServiceProvider, StorageSetupError } from './index.ts';

afterAll(removeDirectories);

function storageConfig(base: string) {
  return defineStorage({
    default: 'local',
    disks: {
      local: { driver: 'local', root: join(base, 'private') },
      public: { driver: 'local', root: join(base, 'public'), visibility: 'public', url: '/storage' },
      cdn: { driver: 'local', root: join(base, 'cdn'), visibility: 'public', url: 'https://cdn.example/files' },
      bucket: { driver: 's3', bucket: 'files', visibility: 'private' },
    },
  });
}

async function boot(config?: ConfigDefinition<unknown>, options: { http?: boolean; fake?: boolean } = {}) {
  const clock = new TestClock();
  clock.freeze();
  const app = await createApplication({
    root: freshDirectory(),
    discover: false,
    env: { APP_KEY: generateKey(), LOG_LEVEL: 'silent' },
    config: config ? [config] : [],
    providers: [EncryptionServiceProvider, ...(options.http === false ? [] : [HttpServiceProvider]), StorageServiceProvider],
    override: (container) => {
      container.instance(Clock, clock);
      if (options.fake) container.instance(Storage, new StorageFake(container));
    },
  });
  const kernel = options.http === false ? undefined : createHttpKernel(app);
  return { app, clock, kernel, storage: app.container.make(Storage) as StorageManager };
}

describe('serving public disks', () => {
  it('serves a public file under its url — raster images inline, with nosniff and a sandbox', async () => {
    const base = freshDirectory();
    const { storage, kernel } = await boot(storageConfig(base));
    await storage.disk('public').put('avatars/ä 7.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    const url = storage.disk('public').url('avatars/ä 7.png');
    expect(url).toBe('/storage/avatars/%C3%A4%207.png');
    const response = await kernel!.request(url);
    expect(response.status).toBe(200);
    expect(Object.fromEntries(response.headers)).toMatchObject({
      'content-type': 'image/png',
      'content-length': '4',
      'x-content-type-options': 'nosniff',
      'content-security-policy': 'sandbox',
      'content-disposition': `inline; filename="_ 7.png"; filename*=UTF-8''%C3%A4%207.png`,
    });
    expect(response.headers.get('last-modified')).toBeTruthy();
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    // HEAD and a conditional GET
    const head = await kernel!.request(url, { method: 'HEAD' });
    expect([head.status, head.headers.get('content-length'), await head.text()]).toEqual([200, '4', '']);
    const again = await kernel!.request(url, { headers: { 'if-modified-since': response.headers.get('last-modified')! } });
    expect(again.status).toBe(304);
  });

  it.each([
    ['page.html', 'text/html'],
    ['logo.svg', 'image/svg+xml'],
    ['doc.xhtml', 'application/xhtml+xml'],
    ['report.pdf', 'application/pdf'],
    ['data.xml', 'application/xml'],
    ['notes.txt', 'text/plain'],
    ['noext', 'application/octet-stream'],
  ])('%s goes out as a download in a sandbox — never rendered on the app’s origin', async (key, type) => {
    const base = freshDirectory();
    const { storage, kernel } = await boot(storageConfig(base));
    await storage.disk('public').put(key, '<html><script>alert(document.cookie)</script></html>');
    const response = await kernel!.request(`/storage/${key}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(type);
    expect(response.headers.get('content-disposition')).toMatch(/^attachment; /);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toBe('sandbox');
  });

  it('HTML in a ".png" stays an image/png (nosniff: the browser does not guess HTML)', async () => {
    const base = freshDirectory();
    const { storage, kernel } = await boot(storageConfig(base));
    await storage.disk('public').put('fake.png', '<html><script>alert(1)</script></html>');
    const response = await kernel!.request('/storage/fake.png');
    expect([response.headers.get('content-type'), response.headers.get('x-content-type-options')]).toEqual(['image/png', 'nosniff']);
  });

  it('traversal through the URL — "%2e%2e/", "..%2f", backslash, NUL, absolute — 404, the private file is not read', async () => {
    const base = freshDirectory();
    const { storage, kernel } = await boot(storageConfig(base));
    await storage.disk('local').put('secret.txt', 'private');
    await storage.disk('public').put('ok.txt', 'ok');
    writeFileSync(join(base, '.env'), 'APP_KEY=secret');
    for (const path of [
      '/storage/%2e%2e/private/secret.txt',
      '/storage/..%2fprivate%2fsecret.txt',
      '/storage/..%2f..%2f.env',
      '/storage/%2e%2e%2f%2e%2e%2f.env',
      '/storage/..%5cprivate%5csecret.txt',
      '/storage/ok.txt%00.png',
      '/storage/%2fetc%2fpasswd',
      `/storage/${encodeURIComponent(join(base, 'private', 'secret.txt'))}`,
    ]) {
      const response = await kernel!.request(path);
      expect(response.status, path).toBe(404);
      expect(await response.text()).not.toContain('private');
    }
    expect(await (await kernel!.request('/storage/ok.txt')).text()).toBe('ok');
  });

  it('a symlink in the public root that leads to the private disk — 404', async () => {
    const base = freshDirectory();
    const { storage, kernel } = await boot(storageConfig(base));
    await storage.disk('local').put('secret.txt', 'private');
    await storage.disk('public').put('ok.txt', 'ok');
    symlinkSync(join(base, 'private', 'secret.txt'), join(base, 'public', 'leak.txt'));
    const response = await kernel!.request('/storage/leak.txt');
    expect(response.status).toBe(404);
  });

  it('private disks have no route — their files are never public', async () => {
    const base = freshDirectory();
    const { storage, kernel } = await boot(storageConfig(base));
    await storage.disk('local').put('exports/7.json', '{"secret":true}');
    for (const path of ['/storage/exports/7.json', '/local/exports/7.json', '/_marmeon/storage/local/exports/7.json']) {
      expect((await kernel!.request(path)).status, path).not.toBe(200);
    }
    expect(() => storage.disk('local').url('exports/7.json')).toThrow('use temporaryUrl(key, { expiresIn })');
  });

  it('a public disk with an absolute url (a CDN) is not served by the app', async () => {
    const base = freshDirectory();
    const { storage, kernel } = await boot(storageConfig(base));
    await storage.disk('cdn').put('a.png', 'x');
    expect(storage.disk('cdn').url('a.png')).toBe('https://cdn.example/files/a.png');
    expect((await kernel!.request('/files/a.png')).status).toBe(404);
  });
});

describe('temporary URLs of local disks', () => {
  it('signed by UrlSigner, expiring by the app clock — served as a download with no-store', async () => {
    const base = freshDirectory();
    const { storage, kernel, clock } = await boot(storageConfig(base));
    await storage.disk('local').put('exports/user 7.json', '{"a":1}');
    const url = await storage.disk('local').temporaryUrl('exports/user 7.json', { expiresIn: { minutes: 5 }, filename: 'my-data.json' });
    expect(url).toMatch(/^\/_marmeon\/storage\/local\/exports\/user%207\.json\?filename=my-data\.json&expires=\d+&signature=[0-9a-f]{64}$/);
    const response = await kernel!.request(url);
    expect(response.status).toBe(200);
    expect(Object.fromEntries(response.headers)).toMatchObject({
      'content-type': 'application/json',
      'content-disposition': `attachment; filename="my-data.json"; filename*=UTF-8''my-data.json`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': 'sandbox',
    });
    expect(await response.text()).toBe('{"a":1}');
    clock.travel({ minutes: 5, seconds: 1 });
    expect((await kernel!.request(url)).status).toBe(403); // expired
  });

  it('a tampered URL — another file, another disk, a longer expiry, another file name, no signature — 403', async () => {
    const base = freshDirectory();
    const { storage, kernel } = await boot(storageConfig(base));
    await storage.disk('local').put('exports/7.json', 'mine');
    await storage.disk('local').put('exports/8.json', 'someone else’s');
    const url = new URL(await storage.disk('local').temporaryUrl('exports/7.json', { expiresIn: 60 }), 'http://localhost');
    const tampered = (change: (url: URL) => void) => {
      const copy = new URL(url);
      change(copy);
      return kernel!.request(copy.pathname + copy.search);
    };
    expect((await tampered(() => {})).status).toBe(200);
    expect((await tampered((u) => (u.pathname = u.pathname.replace('7.json', '8.json')))).status).toBe(403);
    expect((await tampered((u) => (u.pathname = u.pathname.replace('/local/', '/public/')))).status).toBe(403);
    expect((await tampered((u) => u.searchParams.set('expires', String(Number(u.searchParams.get('expires')) + 3600)))).status).toBe(403);
    expect((await tampered((u) => u.searchParams.set('filename', 'x.html'))).status).toBe(403);
    expect((await tampered((u) => u.searchParams.delete('signature'))).status).toBe(403);
    expect((await tampered((u) => u.searchParams.set('signature', '0'.repeat(64)))).status).toBe(403);
  });

  it('a raster image stays inline; HTML on a private disk is a download too', async () => {
    const base = freshDirectory();
    const { storage, kernel } = await boot(storageConfig(base));
    await storage.disk('local').put('a.webp', 'webp');
    await storage.disk('local').put('a.html', '<script>alert(1)</script>');
    const image = await kernel!.request(await storage.disk('local').temporaryUrl('a.webp', { expiresIn: 60 }));
    expect(image.headers.get('content-disposition')).toMatch(/^inline; /);
    const html = await kernel!.request(await storage.disk('local').temporaryUrl('a.html', { expiresIn: 60, filename: 'a.png' }));
    expect([html.headers.get('content-type'), html.headers.get('content-disposition')]).toEqual(['text/html', `attachment; filename="a.png"; filename*=UTF-8''a.png`]);
  });

  it('absolute with a base; a missing file — 404 (the signature is checked first)', async () => {
    const base = freshDirectory();
    const { storage, kernel } = await boot(storageConfig(base));
    const url = await storage.disk('local').temporaryUrl('gone.txt', { expiresIn: 60, base: 'https://app.example' });
    expect(url).toMatch(/^https:\/\/app\.example\/_marmeon\/storage\/local\/gone\.txt\?expires=/);
    const { pathname, search } = new URL(url);
    expect((await kernel!.request(pathname + search)).status).toBe(404);
  });

  it('without @marmeon/http: temporaryUrl() says what is missing', async () => {
    const base = freshDirectory();
    const { storage } = await boot(storageConfig(base), { http: false });
    await expect(storage.disk('local').temporaryUrl('a.txt', { expiresIn: 60 })).rejects.toThrow('needs @marmeon/http');
  });
});

describe('configuration', () => {
  it('without defineStorage: local (private), public (/storage) and uploads (private) under storage/app', async () => {
    const { storage, app } = await boot();
    expect(storage.names).toEqual(['local', 'public', 'uploads']);
    await storage.disk('public').put('a.png', 'x');
    await storage.disk().put('b.txt', 'y');
    expect(storage.disk('public').url('a.png')).toBe('/storage/a.png');
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(join(app.root, 'storage/app/public/a.png'), 'utf8')).toBe('x');
    expect(readFileSync(join(app.root, 'storage/app/private/b.txt'), 'utf8')).toBe('y');
  });

  it('an unknown disk: an error with the disks and a guess', async () => {
    const { storage } = await boot(storageConfig(freshDirectory()));
    expect(() => storage.named('pubic')).toThrow(StorageError);
    expect(() => storage.named('pubic')).toThrow('No disk "pubic" — the disks: local, public, cdn, bucket. Did you mean "public"?');
  });

  it('the disk of temporary uploads must be private — a public one fails the start', async () => {
    const base = freshDirectory();
    const config = defineStorage({
      default: 'local',
      disks: { local: { driver: 'local', root: join(base, 'private') }, uploads: { driver: 'local', root: join(base, 'uploads'), visibility: 'public', url: '/uploads' } },
    });
    await expect(boot(config)).rejects.toThrow('The disk "uploads" holds temporary uploads (UPLOADS_DISK) but is public');
  });

  it('a private disk inside (or around, or on) a public one fails the start', async () => {
    const base = freshDirectory();
    const variants = [
      { local: join(base, 'public', 'private'), public: join(base, 'public') },
      { local: join(base, 'files'), public: join(base, 'files', 'public') },
      { local: join(base, 'same'), public: join(base, 'same') },
    ];
    for (const roots of variants) {
      const config = defineStorage({
        default: 'local',
        disks: { local: { driver: 'local', root: roots.local }, public: { driver: 'local', root: roots.public, visibility: 'public', url: '/storage' } },
      });
      await expect(boot(config)).rejects.toThrow(/The private disk "local" and the public disk "public" share a directory/);
    }
    // …also through a symlinked root
    mkdirSync(join(base, 'real-public'));
    symlinkSync(join(base, 'real-public'), join(base, 'alias'));
    const aliased = defineStorage({
      default: 'local',
      disks: { local: { driver: 'local', root: join(base, 'alias', 'private') }, public: { driver: 'local', root: join(base, 'real-public'), visibility: 'public', url: '/storage' } },
    });
    mkdirSync(join(base, 'real-public', 'private'));
    await expect(boot(aliased)).rejects.toThrow(StorageSetupError);
  });

  it('a private S3 disk whose prefix nests with a public one in the same bucket fails the start', async () => {
    const s3 = (root: string | undefined, visibility: 'public' | 'private', bucket = 'files') => ({ driver: 's3' as const, bucket, root, visibility });
    for (const [closed, open] of [
      ['private', undefined],
      [undefined, 'public'],
      ['files/private', 'files'],
      ['same', '/same/'],
    ] as const) {
      const config = defineStorage({ default: 'a', disks: { a: s3(closed, 'private'), b: s3(open, 'public') } });
      await expect(boot(config)).rejects.toThrow(/The private disk "a" and the public disk "b" share a prefix of one bucket/);
    }
    // Separate prefixes, or another bucket: fine.
    await boot(defineStorage({ default: 'a', disks: { a: s3('private', 'private'), b: s3('public', 'public') } }));
    await boot(defineStorage({ default: 'a', disks: { a: s3(undefined, 'private'), b: s3(undefined, 'public', 'avatars') } }));
    await boot(defineStorage({ default: 'a', disks: { a: s3('files-private', 'private'), b: s3('files', 'public') } }));
  });

  it('a private disk with a url, an unknown default, an unknown driver — startup errors that say what to do', async () => {
    await expect(boot(defineStorage({ default: 'local', disks: { local: { driver: 'local', root: 'x', url: '/files' } } }))).rejects.toThrow(
      'The disk "local" is private but has a url — private files are never public',
    );
    await expect(boot(defineStorage({ default: 'locl' as 'local', disks: { local: { driver: 'local', root: 'x' } } }))).rejects.toThrow(
      'The default disk "locl" is not configured — the disks: local. Did you mean "local"?',
    );
    await expect(boot(defineStorage({ default: 'a', disks: { a: { driver: 'ftp' } as never } }))).rejects.toThrow('unknown driver "ftp"');
    await expect(boot(defineStorage({ default: 'a', disks: { a: { driver: 'local', root: 'x', visibility: 'public', url: 'storage' } } }))).rejects.toThrow('must be a path');
  });

  it('an S3 disk without a bucket fails on first use with the variable to set; without the SDK it says how to install it', async () => {
    const { storage } = await boot(defineStorage({ default: 'a', disks: { a: { driver: 's3', bucket: undefined } } }));
    expect(() => storage.disk('a')).toThrow('has no bucket — set the variable its configuration reads (e.g. S3_BUCKET');
    const { loadS3 } = await import('./drivers/s3.ts');
    const missing = Object.assign(new Error("Cannot find package '@aws-sdk/client-s3' imported from x"), { code: 'ERR_MODULE_NOT_FOUND' });
    await expect(loadS3(() => Promise.reject(missing))).rejects.toThrow(
      'S3 disks need the AWS SDK, which is not installed in this app: pnpm add @aws-sdk/client-s3@^3 @aws-sdk/s3-request-presigner@^3',
    );
  });

  it('an S3 default disk (or UPLOADS_DISK) without the AWS SDK fails the start with the exact command — another S3 disk on first use', async () => {
    const { checkS3Sdk } = await import('./index.ts');
    const { missingPackages } = await import('./drivers/s3.ts');
    const s3 = { driver: 's3', bucket: 'b' } as const;
    const local = { driver: 'local', root: 'x' } as const;
    const gone = (names: readonly string[]) => [...names];
    const message = (() => {
      try {
        checkS3Sdk({ default: 'files', disks: { files: s3, uploads: local } }, 'uploads', gone);
        return 'started';
      } catch (error) {
        return (error as Error).message;
      }
    })();
    // The message as the assertion's text: the whole command shows when it differs (Vitest shortens long strings).
    expect(message, message).toBe('The disk "files" (the default disk) is on S3, which needs the AWS SDK — not installed in this app: pnpm add @aws-sdk/client-s3@^3 @aws-sdk/s3-request-presigner@^3');
    expect(() => checkS3Sdk({ default: 'local', disks: { local, uploads: s3 } }, 'uploads', gone)).toThrow('The disk "uploads" (UPLOADS_DISK) is on S3, which needs the AWS SDK');
    // The SDK without the presigned POST: uploads on S3 need it, an S3 default disk does not.
    const noPost = (names: readonly string[]) => names.filter((name) => name === '@aws-sdk/s3-presigned-post');
    expect(() => checkS3Sdk({ default: 'local', disks: { local, uploads: s3 } }, 'uploads', noPost)).toThrow(
      'uploads go straight to it and need @aws-sdk/s3-presigned-post — not installed in this app: pnpm add @aws-sdk/s3-presigned-post@^3',
    );
    expect(() => checkS3Sdk({ default: 'files', disks: { files: s3, uploads: local } }, 'uploads', noPost)).not.toThrow();
    // An S3 disk the app may never use does not stop the start.
    expect(() => checkS3Sdk({ default: 'local', disks: { local, uploads: local, s3 } }, 'uploads', gone)).not.toThrow();
    // Resolved, not loaded: a missing package is "missing", any other failure passes through.
    const notFound = Object.assign(new Error("Cannot find module '@aws-sdk/client-s3'"), { code: 'MODULE_NOT_FOUND' });
    expect(missingPackages(['@aws-sdk/client-s3'], () => { throw notFound; })).toEqual(['@aws-sdk/client-s3']);
    expect(missingPackages(['@aws-sdk/client-s3'], () => '/x.js')).toEqual([]);
    expect(() => missingPackages(['x'], () => { throw new SyntaxError('broken'); })).toThrow(SyntaxError);
    // This repository has the SDK: an S3 default disk boots.
    await expect(boot(defineStorage({ default: 'a', disks: { a: s3 } }))).resolves.toBeDefined();
  });

  it('env: the disks from validated variables', async () => {
    const config = defineStorage({
      env: env({ FILES_ROOT: env.string() }),
      default: 'files',
      disks: (e) => ({ files: { driver: 'local', root: e.FILES_ROOT } }),
    });
    await expect(boot(config)).rejects.toThrow('FILES_ROOT');
  });
});

describe('the fake', () => {
  it('every configured disk in memory, with its visibility and URLs; routes serve it; assertions', async () => {
    const base = freshDirectory();
    const { storage, kernel } = await boot(storageConfig(base), { fake: true });
    expect(storage).toBeInstanceOf(StorageFake);
    const fake = storage as StorageFake;
    expect(fake.disk('public')).toBeInstanceOf(MemoryDisk);
    expect(fake.disk('bucket')).toBeInstanceOf(MemoryDisk); // S3 too — no SDK, no network
    await fake.disk('public').put('a.png', 'png');
    fake.disk('public').assertExists('a.png').assertExists('a.png', 'png').assertMissing('b.png').assertCount(1);
    expect(() => fake.disk('public').assertExists('b.png')).toThrow('Expected "b.png" on the disk "public". It has: a.png.');
    expect(() => fake.disk('public').assertExists('a.png', 'gif')).toThrow('other contents');
    expect(() => fake.disk('local').assertCount(1)).toThrow('Expected 1 file(s) on the disk "local", found 0');
    expect(await (await kernel!.request('/storage/a.png')).text()).toBe('png');
    await fake.disk('local').put('x.txt', 'private');
    expect(await (await kernel!.request(await fake.disk('local').temporaryUrl('x.txt', { expiresIn: 60 }))).text()).toBe('private');
    await expect(fake.disk('public').get('../x')).rejects.toThrow('".." segment');
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(base)).toEqual([]); // nothing on the file system
  });

  it('diskAttachment(): a file as a mail attachment', async () => {
    const disk = new MemoryDisk({ name: 'local', visibility: 'private', temporaryUrls: { sign: () => '' }, clock: new TestClock() });
    await disk.put('invoices/7.pdf', '%PDF');
    expect(await diskAttachment(disk, 'invoices/7.pdf')).toEqual({ filename: '7.pdf', content: new Uint8Array(Buffer.from('%PDF')), contentType: 'application/pdf' });
    expect((await diskAttachment(disk, 'invoices/7.pdf', { filename: 'Rechnung.pdf' })).filename).toBe('Rechnung.pdf');
  });
});

import { Clock, type Container } from '@marmeon/core';
import type { StorageOptions } from './config.ts';
import { FRAMEWORK_ROUTES } from '@marmeon/router/internal';
import { MAX_TEMPORARY_URL_SECONDS } from './contents.ts';
import { keyFromPath } from './keys.ts';
import { notFound, serveFile } from './serve.ts';
import { Storage, StorageManager, visibilityOf } from './storage.ts';
import { TEMPORARY_PREFIX } from './temporary.ts';

type Http = typeof import('@marmeon/http');

/** `/storage` → the public disks the app serves under a path: local or memory, public, with a `url` that is a path. */
export function servedPublicDisks(options: StorageOptions): { name: string; path: string }[] {
  return Object.entries(options.disks).flatMap(([name, disk]) =>
    (disk.driver === 'local' || disk.driver === 'memory') && visibilityOf(disk) === 'public' && disk.url?.startsWith('/') ? [{ name, path: disk.url.replace(/\/+$/, '') }] : [],
  );
}

/**
 * The routes that serve files — outside every middleware group (no session, no cookies, no CSRF; global middleware
 * still runs):
 *
 * - `GET {url}/<key>` for each public local (or memory) disk whose `url` is a path — e.g. `/storage/avatars/7.webp`;
 * - `GET /_marmeon/storage/<disk>/<key>?expires=…&signature=…` — `temporaryUrl()` of local and memory disks, public or
 *   private, behind `signed()` (a wrong or expired signature: 403).
 *
 * A private disk has no other route: its files are never public. Keys come from the raw path, each segment decoded and
 * checked like every key (`..%2f` included); a refused key and a missing file are the same 404.
 */
export function registerStorageRoutes(http: Http, container: Container, options: StorageOptions): void {
  const storage = () => container.make(Storage) as unknown as StorageManager;
  // The public disks' paths come from the app's configuration: they load without the framework's marker, so a `url` under
  // /_marmeon/ fails the start instead of hiding the signed route below.
  const publicDisks = http.defineRoutes((Root) => {
    // A public disk is public by its configuration: anyone may fetch its files, as the app said when it made the disk public.
    const disks = servedPublicDisks(options);
    if (disks.length === 0) return; // an unused `authorize` fails the load
    const Route = Root.authorize(http.everyone);
    for (const { name, path } of disks) {
      Route.get(`${path}/:path{.+}`, async (ctx) => {
        const key = keyFromPath(new URL(ctx.request.url).pathname, path);
        if (key === undefined) return notFound();
        return serveFile(storage().named(name), key, ctx.request, { cacheControl: 'public, max-age=0, must-revalidate' });
      });
    }
  });
  const temporary = http.defineRoutes((Route) => {
    Route.middleware(http.signed()).get(`${TEMPORARY_PREFIX}/:disk/:path{.+}`, async (ctx) => {
      const url = new URL(ctx.request.url);
      // A link signed with the same key by other means (or before the cap) is refused too: no link outlives seven days
      // (60 seconds of tolerance for clock skew between servers).
      const lasts = Number(url.searchParams.get('expires')) - Math.floor(container.make(Clock).now() / 1000);
      if (!(lasts <= MAX_TEMPORARY_URL_SECONDS + 60)) throw new http.HttpError(403, 'Invalid signature.', {}, { key: 'marmeon.errors.signature' });
      const rest = url.pathname.slice(TEMPORARY_PREFIX.length + 1);
      const slash = rest.indexOf('/');
      let disk: string;
      try {
        disk = decodeURIComponent(rest.slice(0, slash));
      } catch {
        return notFound();
      }
      // Only disks the app serves itself: other drivers (S3, a provider's) answer for their own URLs.
      if (!Object.hasOwn(options.disks, disk) || !['local', 'memory'].includes(options.disks[disk]!.driver)) return notFound();
      const key = keyFromPath(url.pathname, `${TEMPORARY_PREFIX}/${rest.slice(0, slash)}`);
      if (key === undefined) return notFound();
      return serveFile(storage().named(disk), key, ctx.request, {
        cacheControl: 'private, no-store',
        filename: url.searchParams.get('filename') ?? undefined,
      });
    });
  });
  const router = container.make(http.Router);
  router.load(publicDisks);
  router.load({ framework: FRAMEWORK_ROUTES }, temporary);
}

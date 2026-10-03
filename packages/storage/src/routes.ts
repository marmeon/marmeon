import type { Container } from '@bespokecore/core';
import type { StorageOptions } from './config.ts';
import { keyFromPath } from './keys.ts';
import { notFound, serveFile } from './serve.ts';
import { Storage, StorageManager, visibilityOf } from './storage.ts';
import { TEMPORARY_PREFIX } from './temporary.ts';

type Http = typeof import('@bespokecore/http');

/** `/storage` → the public disks the app serves under a path: not S3, public, with a `url` that is a path. */
export function servedPublicDisks(options: StorageOptions): { name: string; path: string }[] {
  return Object.entries(options.disks).flatMap(([name, disk]) =>
    disk.driver !== 's3' && visibilityOf(disk) === 'public' && disk.url?.startsWith('/') ? [{ name, path: disk.url.replace(/\/+$/, '') }] : [],
  );
}

/**
 * The routes that serve files — outside every middleware group (no session, no cookies, no CSRF; global middleware
 * still runs):
 *
 * - `GET {url}/<key>` for each public local (or memory) disk whose `url` is a path — e.g. `/storage/avatars/7.webp`;
 * - `GET /_bespoke/storage/<disk>/<key>?expires=…&signature=…` — `temporaryUrl()` of local and memory disks, public or
 *   private, behind `signed()` (a wrong or expired signature: 403).
 *
 * A private disk has no other route: its files are never public. Keys come from the raw path, each segment decoded and
 * checked like every key (`..%2f` included); a refused key and a missing file are the same 404.
 */
export function registerStorageRoutes(http: Http, container: Container, options: StorageOptions): void {
  const storage = () => container.make(Storage) as unknown as StorageManager;
  const routes = http.defineRoutes((Route) => {
    for (const { name, path } of servedPublicDisks(options)) {
      Route.get(`${path}/:path{.+}`, async (ctx) => {
        const key = keyFromPath(new URL(ctx.request.url).pathname, path);
        if (key === undefined) return notFound();
        return serveFile(storage().named(name), key, ctx.request, { cacheControl: 'public, max-age=0, must-revalidate' });
      });
    }
    Route.middleware(http.signed()).get(`${TEMPORARY_PREFIX}/:disk/:path{.+}`, async (ctx) => {
      const url = new URL(ctx.request.url);
      const rest = url.pathname.slice(TEMPORARY_PREFIX.length + 1);
      const slash = rest.indexOf('/');
      let disk: string;
      try {
        disk = decodeURIComponent(rest.slice(0, slash));
      } catch {
        return notFound();
      }
      // Only disks the app serves itself: S3 disks presign their own URLs.
      if (!Object.hasOwn(options.disks, disk) || options.disks[disk]!.driver === 's3') return notFound();
      const key = keyFromPath(url.pathname, `${TEMPORARY_PREFIX}/${rest.slice(0, slash)}`);
      if (key === undefined) return notFound();
      return serveFile(storage().named(disk), key, ctx.request, {
        cacheControl: 'private, no-store',
        filename: url.searchParams.get('filename') ?? undefined,
      });
    });
  });
  container.make(http.Router).load(routes);
}

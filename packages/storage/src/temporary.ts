import type { TemporaryUrlOptions } from './disk.ts';
import { StorageSetupError } from './errors.ts';

/** Where the app serves files of local and memory disks behind a signed, expiring URL. */
export const TEMPORARY_PREFIX = '/_bespoke/storage';

/**
 * Signs temporary URLs for disks the app serves itself (local, memory): `/_bespoke/storage/<disk>/<key>?expires=…&signature=…`
 * — signed by `UrlSigner` of @bespokecore/http (a key of its own from `APP_KEY`, path and query signed), the expiry from
 * the app's `Clock`. Bound by the `StorageServiceProvider`.
 */
export interface TemporaryUrls {
  sign(disk: string, key: string, options: TemporaryUrlOptions): string;
}

/** Without @bespokecore/http there is nothing to sign with, and no route that would serve the URL. */
export const NO_TEMPORARY_URLS: TemporaryUrls = {
  sign(disk) {
    throw new StorageSetupError(
      `temporaryUrl() on the disk "${disk}" needs @bespokecore/http — its UrlSigner signs the URL and its router serves it (pnpm add @bespokecore/http; bespoke discover).`,
    );
  },
};

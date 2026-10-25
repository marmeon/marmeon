import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestClock } from '@marmeon/core/testing';
import type { S3DiskOptions } from '../config.ts';
import type { Disk, DiskDriverTemporaryUrlOptions, Visibility } from '../disk.ts';
import { LocalDisk } from '../drivers/local.ts';
import { MemoryDisk } from '../drivers/memory.ts';
import { S3Disk } from '../drivers/s3.ts';
import type { TemporaryUrls } from '../temporary.ts';

/** `pnpm test:s3` sets it — an S3-compatible store (compose service `s3`, SeaweedFS). Without it the S3 tests skip. */
export const S3_ENDPOINT = process.env.MARMEON_TEST_S3_ENDPOINT;
export const S3_BUCKET = 'marmeon-test';
export const S3_CREDENTIALS = { accessKeyId: process.env.MARMEON_TEST_S3_KEY ?? 'marmeon', secretAccessKey: process.env.MARMEON_TEST_S3_SECRET ?? 'marmeon-secret' };

/** A temporary-URL signer that only records — the real one (UrlSigner) is tested through the app. */
export const recordingUrls: TemporaryUrls & { last?: { disk: string; key: string; options: DiskDriverTemporaryUrlOptions } } = {
  sign(disk, key, options) {
    recordingUrls.last = { disk, key, options };
    return `/signed/${disk}/${key}`;
  },
};

const directories: string[] = [];

/** A fresh directory (its real path — macOS's /var is a symlink) — removed by {@link removeDirectories}. */
export function freshDirectory(prefix = 'marmeon-storage-'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  directories.push(dir);
  return dir;
}

export function removeDirectories(): void {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function s3Options(root: string, visibility: Visibility = 'private'): S3DiskOptions {
  return { driver: 's3', bucket: S3_BUCKET, region: 'us-east-1', endpoint: S3_ENDPOINT, credentials: S3_CREDENTIALS, root, visibility };
}

let bucketReady: Promise<void> | undefined;

/** Creates the test bucket once (it may exist from an earlier run). */
export function ensureBucket(): Promise<void> {
  bucketReady ??= (async () => {
    const { S3Client, CreateBucketCommand } = createRequire(import.meta.url)('@aws-sdk/client-s3') as typeof import('@aws-sdk/client-s3');
    const client = new S3Client({ region: 'us-east-1', endpoint: S3_ENDPOINT, forcePathStyle: true, credentials: S3_CREDENTIALS });
    try {
      await client.send(new CreateBucketCommand({ Bucket: S3_BUCKET }));
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw error;
    } finally {
      client.destroy();
    }
  })();
  return bucketReady;
}

export interface DiskKind {
  readonly name: 'local' | 'memory' | 's3';
  readonly skip: boolean;
  /** A fresh, empty disk — public with a url when asked. */
  make(clock: TestClock, visibility?: Visibility): Promise<Disk & { close?(): Promise<void> }>;
}

export const DISK_KINDS: readonly DiskKind[] = [
  {
    name: 'local',
    skip: false,
    make: async (_clock, visibility = 'private') =>
      new LocalDisk({ name: 'files', root: join(freshDirectory(), 'root'), visibility, url: visibility === 'public' ? '/storage' : undefined, temporaryUrls: recordingUrls }),
  },
  {
    name: 'memory',
    skip: false,
    make: async (clock, visibility = 'private') =>
      new MemoryDisk({ name: 'files', visibility, url: visibility === 'public' ? '/storage' : undefined, temporaryUrls: recordingUrls, clock }),
  },
  {
    name: 's3',
    skip: !S3_ENDPOINT,
    make: async (clock, visibility = 'private') => {
      await ensureBucket();
      return new S3Disk({ name: 'files', options: s3Options(`t-${randomUUID()}`, visibility), visibility, clock });
    },
  },
];

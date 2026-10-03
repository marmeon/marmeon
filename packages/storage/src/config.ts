import { defineConfig, type ConfigDefinition, type InferOutput, type StandardSchemaV1 } from '@bespokecore/core';
import * as v from 'valibot';
import type { Disk, PrivateDisk, PublicDisk, Visibility } from './disk.ts';

interface DiskBase {
  /** `private` (default): files only through `temporaryUrl()`. `public`: `url()` and, for local disks, a route. */
  readonly visibility?: Visibility;
}

/** Files in a directory of this machine. */
export interface LocalDiskOptions extends DiskBase {
  readonly driver: 'local';
  /** The directory, relative to the app root (or absolute). Created on first use. */
  readonly root: string;
  /**
   * Public disks: where its files are — a path (`/storage`: the app serves them, with safe headers) or an absolute URL
   * (a CDN in front of the directory; then nothing is served by the app).
   */
  readonly url?: string;
}

/** Files in S3 or an S3-compatible store (needs `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`). */
export interface S3DiskOptions extends DiskBase {
  readonly driver: 's3';
  /** `undefined` (an unset variable) fails when the disk is first used, with the variable to set. */
  readonly bucket: string | undefined;
  readonly region?: string | undefined;
  /** S3-compatible stores: their endpoint (`http://127.0.0.1:9000`). */
  readonly endpoint?: string | undefined;
  /** `bucket` in the path instead of the host name (most S3-compatible stores; default: `true` with an `endpoint`). */
  readonly forcePathStyle?: boolean | undefined;
  /** Without them the SDK's default chain applies (environment, instance role, …). */
  readonly credentials?: { readonly accessKeyId: string; readonly secretAccessKey: string; readonly sessionToken?: string } | undefined;
  /** A prefix inside the bucket: several disks (or apps) in one bucket. */
  readonly root?: string | undefined;
  /** Public disks: the base URL of the files (a CDN or the bucket's public URL). Default: endpoint/bucket. */
  readonly url?: string | undefined;
}

/** Files in memory — gone with the process. For tests (the fake uses it) and throwaway setups. */
export interface MemoryDiskOptions extends DiskBase {
  readonly driver: 'memory';
  readonly url?: string;
}

export type DiskOptions = LocalDiskOptions | S3DiskOptions | MemoryDiskOptions;

/** The resolved configuration: the default disk's name and every disk. */
export interface StorageOptions<D extends Readonly<Record<string, DiskOptions>> = Readonly<Record<string, DiskOptions>>, Default extends string = string> {
  readonly default: Default;
  readonly disks: D;
}

/** The app's `defineStorage(…)` — a config definition (list it in `config`) that keeps the disks' types. */
export interface StorageDefinition<D extends Readonly<Record<string, DiskOptions>> = Readonly<Record<string, DiskOptions>>, Default extends string = string>
  extends ConfigDefinition<StorageOptions<D, Default>> {
  readonly storage: true;
}

const NO_ENV = v.object({});

/**
 * The app's disks (E91). List the definition in the app's `config` and register its types once:
 *
 * ```ts
 * // config/storage.ts
 * export const Storage = defineStorage({
 *   env: v.object({ S3_BUCKET: v.optional(v.string()), S3_REGION: v.optional(v.string()) }),
 *   default: 'local',
 *   disks: (env) => ({
 *     local: { driver: 'local', root: 'storage/app/private' },
 *     public: { driver: 'local', root: 'storage/app/public', visibility: 'public', url: '/storage' },
 *     s3: { driver: 's3', bucket: env.S3_BUCKET, region: env.S3_REGION },
 *   }),
 * });
 * declare module '@bespokecore/storage' { interface StorageTypes { storage: typeof Storage } }
 * ```
 *
 * Without a definition the app has `local` (private, `storage/app/private`) and `public` (`storage/app/public` under
 * `/storage`) — Laravel's defaults.
 */
export function defineStorage<const D extends Readonly<Record<string, DiskOptions>>, const Default extends keyof D & string, const Schema extends StandardSchemaV1 = typeof NO_ENV>(definition: {
  readonly env?: Schema;
  readonly default: Default;
  readonly disks: D | ((env: InferOutput<Schema>) => D);
}): StorageDefinition<D, Default> {
  const { disks } = definition;
  return Object.freeze({
    ...defineConfig('storage', {
      env: (definition.env ?? NO_ENV) as Schema,
      resolve: (env: InferOutput<Schema>): StorageOptions<D, Default> => ({
        default: definition.default,
        disks: typeof disks === 'function' ? (disks as (env: InferOutput<Schema>) => D)(env) : disks,
      }),
    }),
    storage: true as const,
  });
}

export function isStorageDefinition(value: unknown): value is StorageDefinition {
  return (value as Partial<StorageDefinition> | undefined)?.storage === true;
}

/** The disks of an app without a `defineStorage(…)`. */
export const DEFAULT_STORAGE: StorageOptions = {
  default: 'local',
  disks: {
    local: { driver: 'local', root: 'storage/app/private' },
    public: { driver: 'local', root: 'storage/app/public', visibility: 'public', url: '/storage' },
  },
};

/**
 * The app's storage, for typed disk names (declaration merging):
 *
 * ```ts
 * declare module '@bespokecore/storage' { interface StorageTypes { storage: typeof Storage } }
 * ```
 *
 * Then `storage.disk('pubic')` is a type error, and `url()` on a private disk too.
 */
export interface StorageTypes {}

type Configured = StorageTypes extends { storage: StorageDefinition<infer D, infer Default> } ? { disks: D; default: Default } : undefined;

/** The app's disk names — any string until the app registers `StorageTypes`. */
export type DiskName = Configured extends { disks: infer D } ? keyof D & string : string;

/** The default disk's name. */
export type DefaultDiskName = Configured extends { default: infer Default extends string } ? Default : string;

/** The constraint of a disk-name parameter: the names (for completions) plus any string, so a wrong one reaches {@link CheckDiskName}. */
export type DiskNameInput = DiskName | (string & {});

type UnionToIntersection<U> = (U extends unknown ? (x: () => U) => void : never) extends (x: infer I) => void ? I : never;
type LastOf<U> = UnionToIntersection<U> extends () => infer R ? R : never;
type Join<U extends string, Done extends string = ''> = [U] extends [never]
  ? Done
  : LastOf<U> extends infer L extends string
    ? Join<Exclude<U, L>, Done extends '' ? L : `${L}, ${Done}`>
    : Done;

type Near<N extends string> = N extends `${infer First}${string}` ? Extract<DiskName, `${First}${string}`> : never;

/** `N` when it is a disk of the app; otherwise a message the compiler shows as the expected type. */
export type CheckDiskName<N extends string> = string extends DiskName
  ? N
  : string extends N
    ? DiskName
    : N extends DiskName
    ? N
      : [Near<N>] extends [never]
        ? `'${N}' is not a disk of this app — its disks: ${Join<DiskName>}`
        : `'${N}' is not a disk of this app — did you mean ${Join<Near<N>>}?`;

/** The disk `N`: {@link PublicDisk} or {@link PrivateDisk} by its configured visibility; {@link Disk} without `StorageTypes`. */
export type DiskFor<N extends string> = Configured extends { disks: infer D }
  ? N extends keyof D
    ? D[N] extends { readonly visibility: 'public' }
      ? PublicDisk
      : PrivateDisk
    : Disk
  : Disk;

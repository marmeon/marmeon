import { defineConfig, env, type ConfigDefinition, type InferOutput, type Resolver, type StandardSchemaV1 } from '@marmeon/core';
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

/**
 * The disk drivers by name, each with its options. A package that brings a driver (`static diskDrivers` on its provider)
 * adds its own through declaration merging; the options carry what the driver needs and no `driver` key:
 *
 * ```ts
 * declare module '@marmeon/storage' { interface DiskDrivers { gcs: { readonly bucket: string } } }
 * ```
 *
 * Then `defineStorage({ disks: { media: { driver: 'gcs', bucket: 'files' } } })` is checked: a missing `bucket` is a type error.
 * Every disk has `visibility` and `url` on top, whatever its driver. See `docs/drivers.md#disk-drivers`.
 */
export interface DiskDrivers {
  local: LocalDiskOptions;
  s3: S3DiskOptions;
  memory: MemoryDiskOptions;
}

/** The options of one disk: the options of its driver, discriminated by `driver`. */
export type DiskOptions = {
  [K in keyof DiskDrivers]: DiskDrivers[K] & DiskBase & { readonly driver: K; readonly url?: string | undefined };
}[keyof DiskDrivers];

/** What a disk driver's factory is given besides the disk's options. */
export interface DiskDriverContext {
  /** The disk's name in the configuration — the `name` of the {@link Disk} the factory returns. */
  readonly name: string;
  /** The app root, for a driver that keeps files relative to it. */
  readonly root: string;
  /** For what the driver needs from the app (its own configuration, the clock, the logger). */
  readonly container: Resolver;
}

/**
 * Creates the disk `context.name` from its options. The disk's `visibility` must be the configured one and its `name` the
 * disk's; a private disk's `temporaryUrl()` must be signed and expire. See `docs/drivers.md#disk-drivers`.
 */
export type DiskDriverFactory<O = any> = (options: O, context: DiskDriverContext) => Disk;

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

const NO_ENV = env({});

/**
 * The app's disks: a config definition to list in the app's `config`, with its types registered once through
 * {@link StorageTypes}. Without one the app has `local` (private, the default), `public` (served under `/storage`) and
 * `uploads` (private, where uploaded files wait for their form). See `docs/storage.md#configuration`.
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
    // Temporary uploads (UPLOADS_DISK): private — a file waits here until a form checked and stored it.
    uploads: { driver: 'local', root: 'storage/app/uploads' },
  },
};

/**
 * The app's storage, for typed disk names (declaration merging):
 *
 * ```ts
 * declare module '@marmeon/storage' { interface StorageTypes { storage: typeof Storage } }
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

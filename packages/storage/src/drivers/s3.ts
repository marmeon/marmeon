import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type * as S3 from '@aws-sdk/client-s3';
import type * as Presigner from '@aws-sdk/s3-request-presigner';
import type * as PresignedPost from '@aws-sdk/s3-presigned-post';
import type { Clock, Duration } from '@marmeon/core';
import type { Disk, FileContents, ListOptions, OpenedFile, PutOptions, TemporaryUrlOptions, Visibility } from '../disk.ts';
import type { S3DiskOptions, StorageOptions } from '../config.ts';
import { secondsOf, toBytes } from '../contents.ts';
import { FileNotFoundError, StorageError, StorageSetupError } from '../errors.ts';
import { basename, encodeKey, normalizeDirectory, normalizeKey } from '../keys.ts';
import { contentDisposition, isInlineType, mimeTypeOf } from '../mime.ts';
import { withCode } from '@marmeon/core/internal';

/**
 * What the CLI or a disk prints when the SDK is missing — optional peers (S3 is one of several drivers, the local one needs
 * nothing), with the major this package is tested with.
 */
export const S3_INSTALL = 'pnpm add @aws-sdk/client-s3@^3 @aws-sdk/s3-request-presigner@^3';

export interface S3Modules {
  readonly client: typeof S3;
  readonly presigner: typeof Presigner;
}

export type ImportS3 = () => Promise<S3Modules>;

// `require`, not `import()`: Node itself picks the SDK's CommonJS build (its `node` condition) either way — and bundlers
// and test runners that prefer the `module` condition would otherwise load an ES build with extensionless imports.
const require = createRequire(import.meta.url);
const importModules: ImportS3 = async () => ({
  client: require('@aws-sdk/client-s3') as typeof S3,
  presigner: require('@aws-sdk/s3-request-presigner') as typeof Presigner,
});

/** What uploads straight to S3 need (presigned POST with a size limit) — installed only by apps that upload there. */
export const S3_UPLOADS_INSTALL = 'pnpm add @aws-sdk/s3-presigned-post@^3';

/** `@aws-sdk/s3-presigned-post`, or how to install it. */
export function loadPresignedPost(): typeof PresignedPost {
  try {
    return require('@aws-sdk/s3-presigned-post') as typeof PresignedPost;
  } catch (error) {
    const { code } = (error ?? {}) as { code?: unknown };
    if (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') {
      throw new StorageSetupError(withCode('S2', `Uploads to an S3 disk need @aws-sdk/s3-presigned-post, which is not installed in this app: ${S3_UPLOADS_INSTALL}`));
    }
    throw error;
  }
}

/** Imports the AWS SDK, or explains how to install it. Other failures (a broken install) pass through. */
export async function loadS3(load: ImportS3 = importModules): Promise<S3Modules> {
  try {
    return await load();
  } catch (error) {
    const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
    if ((code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') && typeof message === 'string' && message.includes('@aws-sdk/')) {
      throw new StorageSetupError(withCode('S2', `S3 disks need the AWS SDK, which is not installed in this app: ${S3_INSTALL}`));
    }
    throw error;
  }
}

/**
 * Which of `names` are not installed — resolved, not loaded (the start stays as quick as without the SDK). Other failures pass
 * through.
 */
export function missingPackages(names: readonly string[], resolve: (name: string) => unknown = (name) => require.resolve(name)): string[] {
  return names.filter((name) => {
    try {
      resolve(name);
      return false;
    } catch (error) {
      const { code } = (error ?? {}) as { code?: unknown };
      if (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') return true;
      throw error;
    }
  });
}

export interface S3DiskConfig {
  readonly name: string;
  readonly options: S3DiskOptions;
  readonly visibility: Visibility;
  readonly clock: Clock;
  readonly load?: ImportS3;
}

/**
 * Where a public S3 disk's files are, up to its root prefix: the configured `url` (a CDN, the bucket's public URL), else
 * `endpoint/bucket` (S3-compatible stores) or the bucket's AWS host.
 */
export function s3BaseUrl(options: S3DiskOptions): string {
  const root = normalizeDirectory(options.root ?? '');
  const base = options.url
    ? options.url.replace(/\/+$/, '')
    : options.endpoint
      ? `${options.endpoint.replace(/\/+$/, '')}/${encodeURIComponent(options.bucket ?? '')}`
      : `https://${options.bucket}.s3.${options.region ?? 'us-east-1'}.amazonaws.com`;
  return root === '' ? base : `${base}/${encodeKey(root)}`;
}

/** An object is not the one that was checked any more (the store answered 412 to a conditional request on its ETag). */
export class ObjectChangedError extends StorageError {
  override name = 'ObjectChangedError';
}

function isPreconditionFailed(error: unknown): boolean {
  const { name, $metadata } = (error ?? {}) as { name?: unknown; $metadata?: { httpStatusCode?: number } };
  return name === 'PreconditionFailed' || $metadata?.httpStatusCode === 412;
}

function isNotFound(error: unknown): boolean {
  const { name, $metadata } = (error ?? {}) as { name?: unknown; $metadata?: { httpStatusCode?: number } };
  return name === 'NoSuchKey' || name === 'NotFound' || $metadata?.httpStatusCode === 404;
}

/**
 * Files in S3 or an S3-compatible store, through `@aws-sdk/client-s3` (an optional peer, loaded on first use).
 * Keys are checked like on every disk — some S3-compatible stores map keys onto paths, where `..` would mean something.
 * `temporaryUrl()` is a presigned GET (signing time from the app's `Clock`), a download unless the file is a raster
 * image. Visibility is the disk's, not the object's: a public disk needs a bucket (or prefix) that its policy makes
 * readable — the disk sets no ACLs.
 */
export class S3Disk implements Disk {
  readonly name: string;
  readonly visibility: Visibility;
  readonly #options: S3DiskOptions;
  readonly #bucket: string;
  readonly #prefix: string;
  readonly #clock: Clock;
  readonly #load: ImportS3 | undefined;
  #modules: Promise<{ modules: S3Modules; client: S3.S3Client }> | undefined;

  constructor(config: S3DiskConfig) {
    const { options } = config;
    if (!options.bucket) {
      throw new StorageSetupError(withCode('S2', `The S3 disk "${config.name}" has no bucket — set the variable its configuration reads (e.g. S3_BUCKET, see .env.example).`));
    }
    this.name = config.name;
    this.visibility = config.visibility;
    this.#options = options;
    this.#bucket = options.bucket;
    const root = normalizeDirectory(options.root ?? '');
    this.#prefix = root === '' ? '' : `${root}/`;
    this.#clock = config.clock;
    this.#load = config.load;
  }

  async put(key: string, contents: FileContents, options: PutOptions = {}): Promise<void> {
    const { modules, client } = await this.#client();
    // A stream of unknown length cannot be one PutObject; it is read first (multipart uploads: later).
    const body = typeof contents === 'string' || contents instanceof Uint8Array ? contents : await toBytes(contents);
    await client.send(new modules.client.PutObjectCommand({ Bucket: this.#bucket, Key: this.#key(key), Body: body, ContentType: options.contentType ?? mimeTypeOf(key) }));
  }

  /**
   * The ETag and size of an object as it is now — what an upload check pins: the conditional methods below refuse (412) any
   * other object under the key. Not part of {@link Disk}; the uploads service uses it.
   */
  async fingerprint(key: string): Promise<{ etag: string | undefined; size: number }> {
    const head = await this.#head(key);
    return { etag: head.ETag, size: head.ContentLength ?? 0 };
  }

  /** The object's bytes, only if it still has `etag` — otherwise {@link ObjectChangedError}. */
  async streamIfMatch(key: string, etag: string): Promise<ReadableStream<Uint8Array>> {
    const { modules, client } = await this.#client();
    try {
      const object = await client.send(new modules.client.GetObjectCommand({ Bucket: this.#bucket, Key: this.#key(key), IfMatch: etag }));
      return object.Body!.transformToWebStream() as ReadableStream<Uint8Array>;
    } catch (error) {
      throw this.#conditional(error, key);
    }
  }

  /** Whether `other` is in the same store under the same credentials — one `CopyObject` reaches both. */
  sharesStoreWith(other: S3Disk): boolean {
    const [a, b] = [this.#options, other.#options];
    return a.endpoint === b.endpoint && (a.region ?? 'us-east-1') === (b.region ?? 'us-east-1') && JSON.stringify(a.credentials ?? null) === JSON.stringify(b.credentials ?? null);
  }

  /** Copies `from` of `source` (same store) to `to` here, only if the source still has `etag`; the copy is stored as `contentType`. */
  async copyIfMatch(source: S3Disk, from: string, to: string, { etag, contentType }: { etag: string; contentType: string }): Promise<void> {
    const { modules, client } = await this.#client();
    try {
      await client.send(
        new modules.client.CopyObjectCommand({
          Bucket: this.#bucket,
          Key: this.#key(to),
          CopySource: `${source.#bucket}/${encodeKey(source.#key(from))}`,
          CopySourceIfMatch: etag,
          MetadataDirective: 'REPLACE',
          ContentType: contentType,
        }),
      );
    } catch (error) {
      throw this.#conditional(error, from);
    }
  }

  /** Stores a stream of known length without reading it whole: `PutObject` with `ContentLength`. */
  async putStream(key: string, body: ReadableStream<Uint8Array>, { size, contentType }: { size: number; contentType: string }): Promise<void> {
    const { modules, client } = await this.#client();
    await client.send(new modules.client.PutObjectCommand({ Bucket: this.#bucket, Key: this.#key(key), Body: Readable.fromWeb(body as NodeReadableStream<Uint8Array>), ContentLength: size, ContentType: contentType }));
  }

  async get(key: string): Promise<Uint8Array> {
    const object = await this.#getObject(key);
    return object.Body!.transformToByteArray();
  }

  async text(key: string): Promise<string> {
    return new TextDecoder().decode(await this.get(key));
  }

  async stream(key: string): Promise<ReadableStream<Uint8Array>> {
    return (await this.open(key)).body;
  }

  async open(key: string): Promise<OpenedFile> {
    const object = await this.#getObject(key);
    return {
      body: object.Body!.transformToWebStream() as ReadableStream<Uint8Array>,
      size: object.ContentLength ?? 0,
      lastModified: object.LastModified ?? new Date(0),
      contentType: object.ContentType ?? mimeTypeOf(key),
    };
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.#head(key);
      return true;
    } catch (error) {
      if (error instanceof FileNotFoundError) return false;
      throw error;
    }
  }

  async delete(key: string): Promise<boolean> {
    // S3 deletes say nothing about whether there was an object — ask first.
    if (!(await this.exists(key))) return false;
    const { modules, client } = await this.#client();
    await client.send(new modules.client.DeleteObjectCommand({ Bucket: this.#bucket, Key: this.#key(key) }));
    return true;
  }

  async move(from: string, to: string): Promise<void> {
    await this.copy(from, to);
    const { modules, client } = await this.#client();
    await client.send(new modules.client.DeleteObjectCommand({ Bucket: this.#bucket, Key: this.#key(from) }));
  }

  async copy(from: string, to: string): Promise<void> {
    const { modules, client } = await this.#client();
    const source = this.#key(from);
    try {
      await client.send(new modules.client.CopyObjectCommand({ Bucket: this.#bucket, Key: this.#key(to), CopySource: `${this.#bucket}/${encodeKey(source)}` }));
    } catch (error) {
      if (isNotFound(error)) throw new FileNotFoundError(this.name, from);
      throw error;
    }
  }

  async size(key: string): Promise<number> {
    return (await this.#head(key)).ContentLength ?? 0;
  }

  async mimeType(key: string): Promise<string> {
    return (await this.#head(key)).ContentType ?? mimeTypeOf(key);
  }

  async lastModified(key: string): Promise<Date> {
    return (await this.#head(key)).LastModified ?? new Date(0);
  }

  async list(directory = '', options: ListOptions = {}): Promise<string[]> {
    const { modules, client } = await this.#client();
    const dir = normalizeDirectory(directory);
    const prefix = `${this.#prefix}${dir === '' ? '' : `${dir}/`}`;
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = await client.send(
        new modules.client.ListObjectsV2Command({ Bucket: this.#bucket, Prefix: prefix, ...(options.recursive ? {} : { Delimiter: '/' }), ...(token ? { ContinuationToken: token } : {}) }),
      );
      for (const object of page.Contents ?? []) {
        const key = object.Key?.slice(this.#prefix.length);
        if (!key) continue;
        try {
          keys.push(normalizeKey(key));
        } catch {
          // An object no key of this disk can address (written by something else).
        }
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return keys.sort();
  }

  url(key: string): string {
    normalizeKey(key);
    if (this.visibility !== 'public') {
      throw new StorageError(`The disk "${this.name}" is private: its files have no public URL — use temporaryUrl(key, { expiresIn }).`);
    }
    return `${s3BaseUrl(this.#options)}/${encodeKey(key)}`;
  }

  async temporaryUrl(key: string, options: TemporaryUrlOptions): Promise<string> {
    const { modules, client } = await this.#client();
    const filename = options.filename ?? basename(key);
    const type = mimeTypeOf(filename);
    const command = new modules.client.GetObjectCommand({
      Bucket: this.#bucket,
      Key: this.#key(key),
      // Only raster images are shown; everything else is a download. The type goes with it: what the object was stored as (an
      // upload's claim) never decides how the store's origin serves it — a `.png` stored as `text/html` is still an image.
      ResponseContentType: type,
      ResponseContentDisposition: contentDisposition(isInlineType(type) ? 'inline' : 'attachment', filename),
    });
    return modules.presigner.getSignedUrl(client, command, { expiresIn: secondsOf(options.expiresIn), signingDate: new Date(this.#clock.now()) });
  }

  /**
   * A presigned POST for the browser to send one file to `key`: a policy the store checks — this key, at most `maxBytes`
   * (`content-length-range`), until it expires (`expiresIn`: seconds, or a `Duration` such as `{ minutes: 15 }`). The browser posts `fields`, then the file as `file`. (The bucket
   * needs a CORS rule that allows the app's origin to POST.)
   */
  async presignedPost(key: string, { maxBytes, expiresIn }: { maxBytes: number; expiresIn: Duration }): Promise<{ url: string; fields: Record<string, string> }> {
    const { client } = await this.#client();
    const { createPresignedPost } = loadPresignedPost();
    const target = this.#key(key);
    return createPresignedPost(client, { Bucket: this.#bucket, Key: target, Conditions: [['content-length-range', 1, maxBytes], ['eq', '$key', target]], Expires: secondsOf(expiresIn) });
  }

  /** Closes the client's sockets. */
  async close(): Promise<void> {
    const built = await this.#modules?.catch(() => undefined);
    built?.client.destroy();
  }

  #key(key: string): string {
    return `${this.#prefix}${normalizeKey(key)}`;
  }

  async #head(key: string): Promise<S3.HeadObjectCommandOutput> {
    const { modules, client } = await this.#client();
    try {
      return await client.send(new modules.client.HeadObjectCommand({ Bucket: this.#bucket, Key: this.#key(key) }));
    } catch (error) {
      if (isNotFound(error)) throw new FileNotFoundError(this.name, key);
      throw error;
    }
  }

  #conditional(error: unknown, key: string): unknown {
    if (isPreconditionFailed(error)) return new ObjectChangedError(`The file "${key}" on the disk "${this.name}" is not the one that was checked.`, { cause: error });
    if (isNotFound(error)) return new FileNotFoundError(this.name, key);
    return error;
  }

  async #getObject(key: string): Promise<S3.GetObjectCommandOutput> {
    const { modules, client } = await this.#client();
    try {
      return await client.send(new modules.client.GetObjectCommand({ Bucket: this.#bucket, Key: this.#key(key) }));
    } catch (error) {
      if (isNotFound(error)) throw new FileNotFoundError(this.name, key);
      throw error;
    }
  }

  #client(): Promise<{ modules: S3Modules; client: S3.S3Client }> {
    this.#modules ??= loadS3(this.#load).then((modules) => {
      const { region, endpoint, forcePathStyle, credentials } = this.#options;
      const client = new modules.client.S3Client({
        region: region ?? 'us-east-1',
        ...(endpoint ? { endpoint } : {}),
        forcePathStyle: forcePathStyle ?? endpoint !== undefined,
        ...(credentials ? { credentials } : {}),
        // S3-compatible stores do not all know the SDK's newer default checksums.
        ...(endpoint ? { requestChecksumCalculation: 'WHEN_REQUIRED' as const, responseChecksumValidation: 'WHEN_REQUIRED' as const } : {}),
      });
      return { modules, client };
    });
    return this.#modules;
  }
}

/**
 * The disks the app is sure to use — the default disk and the uploads' (UPLOADS_DISK) — fail the start when they are on S3 and
 * the AWS SDK is missing (optional peers): the exact command at the start, not an error on the first request. Uploads on S3
 * go straight to the store (a presigned POST) and need `@aws-sdk/s3-presigned-post` too. Other S3 disks say it when first used.
 */
export function checkS3Sdk(options: StorageOptions, uploadsDisk: string, missing: (names: readonly string[]) => string[] = missingPackages): void {
  const used = [...new Set([options.default, uploadsDisk])].filter((name) => options.disks[name]?.driver === 's3');
  if (used.length === 0) return;
  if (missing(['@aws-sdk/client-s3', '@aws-sdk/s3-request-presigner']).length > 0) {
    const what = used.map((name) => `"${name}"${name === options.default ? ' (the default disk)' : ' (UPLOADS_DISK)'}`).join(' and ');
    throw new StorageSetupError(withCode('S2', `The disk ${what} is on S3, which needs the AWS SDK — not installed in this app: ${S3_INSTALL}`));
  }
  if (used.includes(uploadsDisk) && missing(['@aws-sdk/s3-presigned-post']).length > 0) {
    throw new StorageSetupError(withCode('S2', `The disk "${uploadsDisk}" (UPLOADS_DISK) is on S3: uploads go straight to it and need @aws-sdk/s3-presigned-post — not installed in this app: ${S3_UPLOADS_INSTALL}`));
  }
}

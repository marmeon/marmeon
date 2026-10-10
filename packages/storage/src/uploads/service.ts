import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Clock } from '@marmeon/core';
import type { Kysely } from '@marmeon/database';
import { HttpError, ValidationError } from '@marmeon/router';
import type { Disk } from '../disk.ts';
import { FileNotFoundError, StorageSetupError } from '../errors.ts';
import { S3Disk } from '../drivers/s3.ts';
import { formatBytes, type UploadRule } from './rule.ts';
import { SNIFF_BYTES, sniff } from './sniff.ts';
import { RejectedUpload, TemporaryUpload } from './temporary-upload.ts';

/** The table `marmeon make:uploads-table` creates (the app owns the migration; this package types it itself). */
export const UPLOADS_TABLE = 'temporary_uploads';

interface UploadRow {
  id: string;
  session: string;
  route: string;
  field: string;
  disk: string;
  key: string;
  name: string;
  max_bytes: number | string;
  size: number | string | null;
  created_at: number | string;
  expires_at: number | string;
  started_at: number | string | null;
  uploaded_at: number | string | null;
  consumed_at: number | string | null;
}
type Tables = { [UPLOADS_TABLE]: UploadRow };

/** Where the browser sends the file: the app's own route (local and memory disks) or an S3 presigned POST. */
export interface UploadTarget {
  /** Goes into the form's field once the file is there (`tu_<id>.<signature>`). */
  readonly token: string;
  readonly upload: {
    readonly method: 'PUT' | 'POST';
    readonly url: string;
    /** S3: the fields of the POST policy — sent before the file, in this order. */
    readonly fields?: Readonly<Record<string, string>>;
  };
}

/** The request an upload target is asked for: the file as the browser describes it (its word only — checked again later). */
export interface TargetRequest {
  readonly route: string;
  readonly field: string;
  readonly rule: UploadRule;
  /** The session's scope (a hash of its id) — the upload belongs to it. */
  readonly session: string;
  readonly name: string;
  readonly size: number;
}

export interface UploadsOptions {
  /** The infrastructure connection of `temporary_uploads` — resolved on first use. */
  readonly db: () => Kysely<Tables>;
  /** The private disk of temporary uploads. */
  readonly disk: () => Disk;
  readonly clock: Clock;
  /** HMAC keys of the tokens: the first signs, all verify (APP_KEY and APP_PREVIOUS_KEYS, derived). */
  readonly keys: readonly Uint8Array[];
  /** How long a token works (ms). */
  readonly lifetime: number;
  /** How long the browser has to send the file (seconds). */
  readonly sendWithin: number;
  /** The signed URL the bytes of upload `id` go to (local and memory disks). */
  readonly receiveUrl: (id: string, expiresIn: number) => string;
}

const TOKEN = /^tu_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([\w-]{43})$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A field's validation error (422) with a key the request's translator turns into its language. */
export function uploadError(field: string, key: string, message: string, params: Record<string, unknown> = {}): ValidationError {
  const filled = message.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
  const issue = { message: filled, path: field.split('.'), [Symbol.for('marmeon.translation')]: { key, params } };
  return ValidationError.fromIssues([issue], {});
}

/**
 * Temporary uploads: the table of tokens and the private disk their files wait on. A target is
 * handed out for one route's field and one session; the bytes arrive once, cut off at the field's `maxBytes`; on submit the
 * token is verified (signature, session, route and field, expiry, not used) and the file's type read from its bytes; storing
 * it uses the token up — one `UPDATE … WHERE consumed_at IS NULL`, so of two submits racing exactly one wins.
 *
 * The table is infrastructure: the statements run on their own connection and never join the app's transaction —
 * a rollback after `store()` never makes a used token usable again (a second store of the same upload).
 */
export class TemporaryUploads {
  readonly #options: UploadsOptions;

  constructor(options: UploadsOptions) {
    this.#options = options;
  }

  get disk(): Disk {
    return this.#options.disk();
  }

  /** A target for one file: a row for its token, and where the bytes go. A file the browser says is too large: 422 at once. */
  async target(request: TargetRequest): Promise<UploadTarget> {
    const { rule, field } = request;
    if (request.size > rule.maxBytes) throw uploadError(field, 'marmeon.validation.upload.max', 'The file may be at most {max}.', { max: formatBytes(rule.maxBytes) });
    const disk = this.disk;
    const id = randomUUID();
    const now = this.#options.clock.now();
    await this.#options
      .db()
      .insertInto(UPLOADS_TABLE)
      .values({
        id,
        session: request.session,
        route: request.route,
        field,
        disk: disk.name,
        key: id,
        name: request.name.slice(0, 255),
        max_bytes: rule.maxBytes,
        size: null,
        created_at: now,
        expires_at: now + this.#options.lifetime,
        started_at: null,
        uploaded_at: null,
        consumed_at: null,
      })
      .execute();
    const token = `tu_${id}.${this.#sign(id)}`;
    if (disk instanceof S3Disk) {
      const post = await disk.presignedPost(id, { maxBytes: rule.maxBytes, expiresIn: this.#options.sendWithin });
      return { token, upload: { method: 'POST', url: post.url, fields: post.fields } };
    }
    return { token, upload: { method: 'PUT', url: this.#options.receiveUrl(id, this.#options.sendWithin) } };
  }

  /**
   * The bytes of upload `id` (a local or memory disk): once per upload, for its session, cut off after the field's `maxBytes`
   * — whatever `Content-Length` said — with nothing left behind (the disk writes a temporary file and renames it only when
   * complete). Returns the size.
   */
  async receive(id: string, session: string, body: ReadableStream<Uint8Array> | null, declared: number | undefined): Promise<number> {
    if (!ID.test(id)) throw new HttpError(404);
    const db = this.#options.db();
    const row = await db.selectFrom(UPLOADS_TABLE).selectAll().where('id', '=', id).executeTakeFirst();
    const now = this.#options.clock.now();
    if (!row || row.session !== session || Number(row.expires_at) <= now) throw new HttpError(404);
    const max = Number(row.max_bytes);
    if (declared !== undefined && declared > max) throw new HttpError(413, `The file may be at most ${formatBytes(max)}.`);
    // One sender: the first claims the upload.
    const claimed = await db.updateTable(UPLOADS_TABLE).set({ started_at: now }).where('id', '=', id).where('started_at', 'is', null).executeTakeFirst();
    if (Number(claimed.numUpdatedRows) !== 1) throw new HttpError(409, 'This upload was sent already.');
    if (!body) throw new HttpError(400, 'The upload has no body.');
    let size = 0;
    let tooLarge = false;
    const limited = body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          size += chunk.byteLength;
          if (size > max) {
            tooLarge = true;
            controller.error(new HttpError(413, `The file may be at most ${formatBytes(max)}.`));
            return;
          }
          controller.enqueue(chunk);
        },
      }),
    );
    const disk = this.#named(row.disk);
    try {
      await disk.put(row.key, limited);
    } catch (error) {
      // Cut off (or the client went away): nothing of it stays — the disk removed its temporary file.
      await disk.delete(row.key).catch(() => false);
      if (tooLarge) throw new HttpError(413, `The file may be at most ${formatBytes(max)}.`);
      throw error;
    }
    await db.updateTable(UPLOADS_TABLE).set({ size, uploaded_at: this.#options.clock.now() }).where('id', '=', id).execute();
    return size;
  }

  /**
   * What an upload field's token stands for — for this session, route and field — verified, with the file's type read from its
   * bytes; or why it is refused (the same `invalid` for a forged token, another session's, another field's, one never sent).
   */
  async resolve(value: string, scope: { session: string; route: string; field: string }): Promise<TemporaryUpload | RejectedUpload> {
    const match = TOKEN.exec(value);
    if (!match || !this.#verify(match[1]!, match[2]!)) return new RejectedUpload('invalid');
    const id = match[1]!;
    const row = await this.#options.db().selectFrom(UPLOADS_TABLE).selectAll().where('id', '=', id).executeTakeFirst();
    if (!row || row.session !== scope.session || row.route !== scope.route || row.field !== scope.field) return new RejectedUpload('invalid');
    if (row.consumed_at !== null) return new RejectedUpload('used');
    if (Number(row.expires_at) <= this.#options.clock.now()) return new RejectedUpload('expired');
    const disk = this.#named(row.disk);
    let size: number;
    let head: Uint8Array;
    try {
      // A local upload knows its size once complete; an S3 one is asked (its POST policy capped it).
      if (row.uploaded_at === null && !(disk instanceof S3Disk)) return new RejectedUpload('invalid');
      size = row.size === null ? await disk.size(row.key) : Number(row.size);
      head = await firstBytes(disk, row.key, SNIFF_BYTES);
    } catch (error) {
      if (error instanceof FileNotFoundError) return new RejectedUpload('invalid');
      throw error;
    }
    const { mime, extension } = sniff(head);
    return new TemporaryUpload({ id, field: row.field, name: row.name, size, mime, extension }, { disk, key: row.key, consume: () => this.consume(id) });
  }

  /** Uses upload `id` up — `false` when it was used already or has expired. One statement: of two at once, one wins. */
  async consume(id: string): Promise<boolean> {
    const now = this.#options.clock.now();
    const result = await this.#options
      .db()
      .updateTable(UPLOADS_TABLE)
      .set({ consumed_at: now })
      .where('id', '=', id)
      .where('consumed_at', 'is', null)
      .where('expires_at', '>', now)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  /**
   * Deletes the uploads made before `before` (epoch ms) — the rows first, in one statement, then their files: a token being
   * used right now either still finds its row (and its file) or finds neither. Returns how many.
   */
  async prune(before: number): Promise<number> {
    const rows = await this.#options.db().deleteFrom(UPLOADS_TABLE).where('created_at', '<=', before).returning(['disk', 'key']).execute();
    for (const row of rows) {
      try {
        await this.#named(row.disk).delete(row.key);
      } catch {
        // A disk no longer configured, or a file already gone: the row is what counted.
      }
    }
    return rows.length;
  }

  #named(name: string): Disk {
    const disk = this.disk;
    if (disk.name !== name) throw new StorageSetupError(`An upload is on the disk "${name}", but uploads use "${disk.name}" now (UPLOADS_DISK).`);
    return disk;
  }

  #sign(id: string): string {
    return createHmac('sha256', this.#options.keys[0]!).update(`upload:${id}`).digest('base64url');
  }

  #verify(id: string, signature: string): boolean {
    const given = Buffer.from(signature, 'base64url');
    // Every key is tried, constant-time: the time tells nothing about which nearly matched.
    let valid = false;
    for (const key of this.#options.keys) valid = timingSafeEqual(createHmac('sha256', key).update(`upload:${id}`).digest(), given) || valid;
    return valid;
  }
}

/** The first `count` bytes of a file (fewer when it is shorter). */
async function firstBytes(disk: Disk, key: string, count: number): Promise<Uint8Array> {
  const reader = (await disk.stream(key)).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < count) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(Math.min(size, count));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk.subarray(0, bytes.length - offset), offset);
    offset += chunk.byteLength;
    if (offset >= bytes.length) break;
  }
  return bytes;
}

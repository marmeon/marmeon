import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Clock } from '@marmeon/core';
import { sql, type Connection } from '@marmeon/database';
import { HttpError, ValidationError } from '@marmeon/router';
import type { Disk } from '../disk.ts';
import { FileNotFoundError, StorageSetupError } from '../errors.ts';
import { ObjectChangedError, S3Disk } from '../drivers/s3.ts';
import { formatBytes, type UploadRule } from './rule.ts';
import { isPlainText, SNIFF_BYTES, sniff } from './sniff.ts';
import { RejectedUpload, TemporaryUpload } from './temporary-upload.ts';
import { withCode } from '@marmeon/core/internal';

/** The table `marmeon make:uploads-table` creates (the app owns the migration; this package types it itself). */
export const UPLOADS_TABLE = 'temporary_uploads';
/** The columns the service reads and writes; readiness is red while the table lacks one. */
export const UPLOADS_COLUMNS = ['id', 'session', 'route', 'field', 'disk', 'key', 'name', 'max_bytes', 'size', 'created_at', 'expires_at', 'started_at', 'uploaded_at', 'consumed_at'];

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
  readonly db: () => Connection<Tables>;
  /** The private disk of temporary uploads. */
  readonly disk: () => Disk;
  readonly clock: Clock;
  /** HMAC keys of the tokens: the first signs, all verify (APP_KEY and APP_PREVIOUS_KEYS, derived). */
  readonly keys: readonly Uint8Array[];
  /** How long a token works. */
  readonly lifetimeMilliseconds: number;
  /** How long the browser has to send the file. */
  readonly sendWithinSeconds: number;
  /** Open uploads (not used, token still works) one session may hold. */
  readonly maxOpen: number;
  /** Bytes the open uploads of one session may announce together. */
  readonly maxOpenBytes: number;
  /** Bytes the open uploads of all sessions may announce together; 0 = no limit. */
  readonly maxOpenTotalBytes: number;
  /** The signed URL the bytes of upload `id` go to (local and memory disks). */
  readonly receiveUrl: (id: string, expiresInSeconds: number) => string;
}

/** Every open upload counts for at least this many bytes in the sums, so files of 0 or 1 byte still run into the limits (a row costs more than its file). */
export const OPEN_UPLOAD_MIN_CHARGE = 64 * 1024;

/** How often a target that lost a race for the last place tries again before it is turned away. */
const SETTLE_ATTEMPTS = 5;

const CHARGE = sql`case when size > ${OPEN_UPLOAD_MIN_CHARGE} then size else ${OPEN_UPLOAD_MIN_CHARGE} end`;

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
 * handed out for one route's field and one session; the bytes arrive once, cut off at the size the browser announced (never above
 * the field's `maxBytes`); the open ones are counted against `maxOpen`, `maxOpenBytes` and `maxOpenTotalBytes`; on submit the
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

  /**
   * A target for one file: a row for its token, and where the bytes go. A file the browser says is too large: 422 at once. A
   * session over its open uploads, or all sessions over theirs: 429 with `Retry-After` — what keeps unsent files from filling the disk.
   */
  async target(request: TargetRequest): Promise<UploadTarget> {
    const { rule, field } = request;
    // A file no limit would ever take is a 422 with the real maximum, not a 429 that promises a later try.
    const { maxOpenBytes, maxOpenTotalBytes } = this.#options;
    const largest = Math.min(rule.maxBytes, maxOpenBytes, maxOpenTotalBytes === 0 ? Infinity : maxOpenTotalBytes);
    if (request.size > largest) throw uploadError(field, 'marmeon.validation.upload.max', 'The file may be at most {max}.', { max: formatBytes(largest) });
    const disk = this.disk;
    const id = randomUUID();
    const now = this.#options.clock.now();
    const db = this.#options.db();
    const charge = Math.max(request.size, OPEN_UPLOAD_MIN_CHARGE);
    // Counting and inserting are one statement, so requests one after another never get past a limit. On a database where statements
    // do not see each other's uncommitted rows (Postgres), requests at the very same moment may all have counted before any inserted:
    // the count after the insert settles it, and those that find a limit passed give way — and try again a moment later, so a burst
    // does not turn everyone away.
    for (let attempt = 1; ; attempt++) {
      const { numAffectedRows } = await this.#insertWithinLimits(db, {
        id,
        session: request.session,
        route: request.route,
        field,
        disk: disk.name,
        name: request.name.slice(0, 255),
        maxBytes: rule.maxBytes,
        size: request.size,
        charge,
        now,
      });
      if (numAffectedRows !== 1n) throw await this.#tooMany(db, request.session, charge, now);
      if (!(await this.#over(db, request.session, 0, 0, now))) break;
      await db.deleteFrom(UPLOADS_TABLE).where('id', '=', id).execute();
      if (attempt === SETTLE_ATTEMPTS) throw await this.#tooMany(db, request.session, charge, now);
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 20 * attempt));
    }
    const token = `tu_${id}.${this.#sign(id)}`;
    if (disk instanceof S3Disk) {
      const post = await disk.presignedPost(id, { maxBytes: Math.max(1, request.size), expiresIn: this.#options.sendWithinSeconds });
      return { token, upload: { method: 'POST', url: post.url, fields: post.fields } };
    }
    return { token, upload: { method: 'PUT', url: this.#options.receiveUrl(id, this.#options.sendWithinSeconds) } };
  }

  /**
   * The bytes of upload `id` (a local or memory disk): once per upload, for its session, cut off after the size announced with its target (at most the field's `maxBytes`)
   * — whatever `Content-Length` said — with nothing left behind (the disk writes a temporary file and renames it only when
   * complete). Returns the size.
   */
  async receive(id: string, session: string, body: ReadableStream<Uint8Array> | null, declared: number | undefined): Promise<number> {
    if (!ID.test(id)) throw new HttpError(404);
    const db = this.#options.db();
    const row = await db.selectFrom(UPLOADS_TABLE).selectAll().where('id', '=', id).executeTakeFirst();
    const now = this.#options.clock.now();
    if (!row || row.session !== session || Number(row.expires_at) <= now) throw new HttpError(404);
    // The size the browser announced is the limit — the open uploads were counted by it.
    const max = Math.min(Number(row.max_bytes), row.size === null ? Infinity : Number(row.size));
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
    let etag: string | undefined;
    try {
      if (disk instanceof S3Disk) {
        // The ETag of the object as it is now: what is read here, and later stored, must be this object — the POST policy lets
        // the browser send to the key again until it expires.
        const found = await disk.fingerprint(row.key);
        if (found.etag === undefined) return new RejectedUpload('invalid');
        etag = found.etag;
        size = found.size;
        head = await firstBytes(await disk.streamIfMatch(row.key, found.etag), SNIFF_BYTES);
      } else {
        // A local upload knows its size once complete.
        if (row.uploaded_at === null) return new RejectedUpload('invalid');
        size = Number(row.size);
        head = await firstBytes(await disk.stream(row.key), SNIFF_BYTES);
      }
    } catch (error) {
      if (error instanceof FileNotFoundError || error instanceof ObjectChangedError) return new RejectedUpload('invalid');
      throw error;
    }
    const { mime, extension } = sniff(head);
    return new TemporaryUpload({ id, field: row.field, name: row.name, size, mime, extension, plainText: isPlainText(head, size) }, { disk, key: row.key, etag, consume: () => this.consume(id) });
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
   * Deletes the uploads that expired unused and those made before `before` (epoch ms) — the rows first, in one
   * statement, then their files: a token being used right now either still finds its row (and its file) or finds neither.
   * Returns how many.
   */
  async prune(before: number): Promise<number> {
    const rows = await this.#options
      .db()
      .deleteFrom(UPLOADS_TABLE)
      .where((eb) => eb.or([eb.and([eb('expires_at', '<=', this.#options.clock.now()), eb('consumed_at', 'is', null)]), eb('created_at', '<=', before)]))
      .returning(['disk', 'key'])
      .execute();
    for (const row of rows) {
      try {
        await this.#named(row.disk).delete(row.key);
      } catch {
        // A disk no longer configured, or a file already gone: the row is what counted.
      }
    }
    return rows.length;
  }

  async #insertWithinLimits(
    db: Connection<Tables>,
    row: { id: string; session: string; route: string; field: string; disk: string; name: string; maxBytes: number; size: number; charge: number; now: number },
  ): Promise<{ numAffectedRows: bigint }> {
    const { maxOpen, maxOpenBytes, maxOpenTotalBytes } = this.#options;
    const open = sql`consumed_at is null and expires_at > ${row.now}`;
    const total = maxOpenTotalBytes === 0 ? sql`1 = 1` : sql`(select coalesce(sum(${CHARGE}), 0) from ${sql.table(UPLOADS_TABLE)} where ${open}) + ${row.charge} <= ${maxOpenTotalBytes}`;
    const result = await sql`
      insert into ${sql.table(UPLOADS_TABLE)}
        (id, session, route, field, disk, key, name, max_bytes, size, created_at, expires_at, started_at, uploaded_at, consumed_at)
      select ${row.id}, ${row.session}, ${row.route}, ${row.field}, ${row.disk}, ${row.id}, ${row.name}, cast(${row.maxBytes} as bigint),
        cast(${row.size} as bigint), cast(${row.now} as bigint), cast(${row.now + this.#options.lifetimeMilliseconds} as bigint), null, null, null
      where (select count(*) from ${sql.table(UPLOADS_TABLE)} where session = ${row.session} and ${open}) < ${maxOpen}
        and (select coalesce(sum(${CHARGE}), 0) from ${sql.table(UPLOADS_TABLE)} where session = ${row.session} and ${open}) + ${row.charge} <= ${maxOpenBytes}
        and ${total}
    `.execute(db).catch((error: unknown) => {
      // The table is the app's to make: say which command makes it, not the driver's "no such table".
      const message = String((error as Error)?.message);
      if (message.includes(UPLOADS_TABLE) && /no such table|does not exist/i.test(message)) {
        throw new StorageSetupError(`The table ${UPLOADS_TABLE} is missing — run marmeon make:uploads-table, then marmeon migrate.`, { cause: error });
      }
      throw error;
    });
    return { numAffectedRows: BigInt(result.numAffectedRows ?? 0) };
  }

  /** Whether the open uploads of `session` (and of all) stand over a limit once `count` more files and `bytes` more bytes are added. */
  async #over(db: Connection<Tables>, session: string, count: number, bytes: number, now: number): Promise<'session' | 'total' | undefined> {
    const { maxOpen, maxOpenBytes, maxOpenTotalBytes } = this.#options;
    const open = sql`consumed_at is null and expires_at > ${now}`;
    const mine = await sql<{ files: number | string; bytes: number | string | null }>`
      select count(*) as files, coalesce(sum(${CHARGE}), 0) as bytes from ${sql.table(UPLOADS_TABLE)} where session = ${session} and ${open}
    `.execute(db);
    if (Number(mine.rows[0]!.files) + count > maxOpen || Number(mine.rows[0]!.bytes) + bytes > maxOpenBytes) return 'session';
    if (maxOpenTotalBytes === 0) return undefined;
    const all = await sql<{ bytes: number | string | null }>`select coalesce(sum(${CHARGE}), 0) as bytes from ${sql.table(UPLOADS_TABLE)} where ${open}`.execute(db);
    return Number(all.rows[0]!.bytes) + bytes > maxOpenTotalBytes ? 'total' : undefined;
  }

  /** The 429 of a target over a limit: `Retry-After` is when the first open upload that counts expires. */
  async #tooMany(db: Connection<Tables>, session: string, size: number, now: number): Promise<HttpError> {
    const over = (await this.#over(db, session, 1, size, now)) ?? 'total';
    const oldest = await sql<{ at: number | string | null }>`
      select min(expires_at) as at from ${sql.table(UPLOADS_TABLE)}
      where consumed_at is null and expires_at > ${now} ${over === 'session' ? sql`and session = ${session}` : sql``}
    `.execute(db);
    const at = oldest.rows[0]?.at;
    const seconds = at === null || at === undefined ? 60 : Math.max(1, Math.ceil((Number(at) - now) / 1000));
    return new HttpError(429, 'Too many files are waiting to be sent. Send the form, or wait a little and choose the file again.', { 'retry-after': String(seconds) }, { key: 'marmeon.validation.upload.too_many' });
  }

  #named(name: string): Disk {
    const disk = this.disk;
    if (disk.name !== name) throw new StorageSetupError(withCode('S2', `An upload is on the disk "${name}", but uploads use "${disk.name}" now (UPLOADS_DISK).`));
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
async function firstBytes(stream: ReadableStream<Uint8Array>, count: number): Promise<Uint8Array> {
  const reader = stream.getReader();
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

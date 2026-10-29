import { randomBytes } from 'node:crypto';
import { ValidationError } from '@marmeon/router';
import type { Disk } from '../disk.ts';
import { ObjectChangedError, S3Disk } from '../drivers/s3.ts';
import { normalizeDirectory } from '../keys.ts';

/** @internal Why an upload token was refused — the user sees one message per kind, never which check failed in detail. */
export type UploadProblem = 'invalid' | 'expired' | 'used';

/** Where the bytes of an upload are, and how it is used up — the service of @marmeon/storage hands it over. */
export interface UploadSource {
  /** The private disk of temporary uploads, and the file's key there. */
  readonly disk: Disk;
  readonly key: string;
  /** An S3 object's ETag as the check saw it: the file is stored only if it still has it. */
  readonly etag?: string | undefined;
  /** Marks the upload used — once: `false` when it was used already (or expired meanwhile). Atomic across processes. */
  consume(): Promise<boolean>;
}

/** Where `translatable()` of the router leaves a message's key on an issue — the request's translator reads it. */
const TRANSLATION = Symbol.for('marmeon.translation');

/** 26 characters of base32 (130 bits): a stored file's name — never the uploader's. */
function randomName(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  const bytes = randomBytes(26);
  let name = '';
  for (const byte of bytes) name += alphabet[byte & 31];
  return name;
}

/**
 * A file uploaded ahead and verified — what an `upload()` field is in `ctx.body`. Its type comes from its bytes, its
 * name from the browser (for showing only). `store()` uses it up — once — and moves the file where it belongs, under a random
 * name with the extension of its real type:
 *
 * ```ts
 * const path = await ctx.body.avatar.store(this.#storage.disk('public'), 'avatars');   // 'avatars/q3k…x7.webp'
 * ```
 *
 * Never serialized: in old input (a failed submit) or a log it is nothing — neither the token nor the file.
 */
export class TemporaryUpload {
  /** The upload's id (not its token). */
  readonly id: string;
  /** The field it was uploaded for (`avatar`). */
  readonly field: string;
  /** The file name the browser sent — for showing it; never a path, never where it is stored. */
  readonly name: string;
  readonly size: number;
  /** The type by its bytes (`image/png`) — `application/octet-stream` when it has no signature known here. */
  readonly mime: string;
  /** @internal The extension of that type (`png`) — what `store()` names the file with. */
  readonly extension: string;
  /** @internal Whether its first bytes pass as text (no signature, no markup, no NUL) — what `upload({ text: true })` accepts. */
  readonly plainText: boolean;
  readonly #source: UploadSource;

  /** @internal The uploads service makes them. */
  constructor(details: { id: string; field: string; name: string; size: number; mime: string; extension: string; plainText?: boolean }, source: UploadSource) {
    this.id = details.id;
    this.field = details.field;
    this.name = details.name;
    this.size = details.size;
    this.mime = details.mime;
    this.extension = details.extension;
    this.plainText = details.plainText ?? false;
    this.#source = source;
  }

  /**
   * Uses the upload up and stores the file on `disk` in `directory`, under a random name with the extension of its type —
   * returns the key (`avatars/q3k…x7.png`). An upload already used (two submits racing) is a validation error of its field
   * (422): only one of them stores the file.
   */
  async store(disk: Disk, directory = ''): Promise<string> {
    if (!(await this.#source.consume())) {
      throw ValidationError.fromIssues(
        [Object.assign({ message: 'This file was saved already — choose it again.', path: this.field.split('.') }, { [TRANSLATION]: { key: 'marmeon.validation.upload.used' } })],
        {},
      );
    }
    const dir = normalizeDirectory(directory);
    const key = `${dir === '' ? '' : `${dir}/`}${randomName()}.${this.extension}`;
    const source = this.#source.disk;
    const { etag } = this.#source;
    if (source instanceof S3Disk && etag !== undefined) {
      // The file the check saw, or nothing: a second POST to the same policy changes the object, and with it the ETag.
      let body: ReadableStream<Uint8Array> | undefined;
      try {
        if (disk instanceof S3Disk && source.sharesStoreWith(disk)) {
          await disk.copyIfMatch(source, this.#source.key, key, { etag, contentType: this.mime });
        } else {
          body = await source.streamIfMatch(this.#source.key, etag);
          if (disk instanceof S3Disk) await disk.putStream(key, body, { size: this.size, contentType: this.mime });
          else await disk.put(key, body, { contentType: this.mime });
        }
      } catch (error) {
        await body?.cancel().catch(() => {});
        await source.delete(this.#source.key).catch(() => false);
        if (error instanceof ObjectChangedError) {
          throw ValidationError.fromIssues(
            [Object.assign({ message: 'The file did not arrive — choose it again.', path: this.field.split('.') }, { [TRANSLATION]: { key: 'marmeon.validation.upload.invalid' } })],
            {},
          );
        }
        throw error;
      }
      await source.delete(this.#source.key).catch(() => false);
      return key;
    }
    if (source === disk) {
      await source.move(this.#source.key, key);
    } else {
      await disk.put(key, await source.stream(this.#source.key), { contentType: this.mime });
      // The temporary file goes now; if that fails, `uploads:prune` takes it with its row.
      await source.delete(this.#source.key).catch(() => false);
    }
    return key;
  }

  /** Nothing: an upload is never part of serialized input (old input, logs). */
  toJSON(): undefined {
    return undefined;
  }
}

/** An upload field's value the validation hook refused — the rule reports why (422). Never serialized. */
export class RejectedUpload {
  readonly problem: UploadProblem;

  /** @internal The uploads service makes them. */
  constructor(problem: UploadProblem) {
    this.problem = problem;
  }

  toJSON(): undefined {
    return undefined;
  }
}

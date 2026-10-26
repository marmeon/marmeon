import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import type { ReadableStream as NodeWebStream } from 'node:stream/web';
import { durationToSeconds, type Duration } from '@marmeon/core';
import type { DiskDriverTemporaryUrlOptions, FileContents, TemporaryUrlOptions } from './disk.ts';

/** Contents as a Node stream — what a file write pipes. */
export function toReadable(contents: FileContents): Readable {
  if (typeof contents === 'string') return Readable.from([Buffer.from(contents, 'utf8')]);
  if (contents instanceof Uint8Array) return Readable.from([Buffer.from(contents.buffer, contents.byteOffset, contents.byteLength)]);
  if (contents instanceof ArrayBuffer) return Readable.from([Buffer.from(contents)]);
  if (contents instanceof Blob) return Readable.fromWeb(contents.stream() as NodeWebStream<Uint8Array>);
  if (contents instanceof Readable) return contents;
  return Readable.fromWeb(contents as NodeWebStream<Uint8Array>);
}

/** Contents as bytes — read completely (memory disk, S3 puts of a stream). */
export async function toBytes(contents: FileContents): Promise<Uint8Array> {
  if (typeof contents === 'string') return new Uint8Array(Buffer.from(contents, 'utf8'));
  if (contents instanceof Uint8Array) return new Uint8Array(contents);
  if (contents instanceof ArrayBuffer) return new Uint8Array(contents.slice(0));
  if (contents instanceof Blob) return new Uint8Array(await contents.arrayBuffer());
  return new Uint8Array(await buffer(toReadable(contents)));
}

/** Bytes as a web stream. */
export function bytesStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** What a driver is given for the app's `temporaryUrl()` options: `expiresIn` as whole seconds. */
export function forDriver({ expiresIn, filename, base }: TemporaryUrlOptions): DiskDriverTemporaryUrlOptions {
  return { expiresInSeconds: secondsOf(expiresIn), ...(filename === undefined ? {} : { filename }), ...(base === undefined ? {} : { base }) };
}

/** The longest a temporary URL may last, on every disk: the limit of S3's presigned URLs (seven days). */
export const MAX_TEMPORARY_URL_SECONDS = 604_800;

/** Whole seconds of a {@link Duration}, rounded down (a link never outlives what was asked); refuses zero, negative, non-finite and over-seven-day spans. */
export function secondsOf(expiresIn: Duration): number {
  const seconds = durationToSeconds(expiresIn);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new RangeError(`expiresIn must be a positive time span, not ${JSON.stringify(expiresIn)}.`);
  const whole = Math.floor(seconds);
  if (whole < 1) throw new RangeError(`expiresIn must be at least one second, not ${JSON.stringify(expiresIn)}.`);
  if (whole > MAX_TEMPORARY_URL_SECONDS) {
    throw new RangeError(`expiresIn is at most 7 days (the limit of S3's presigned URLs), not ${JSON.stringify(expiresIn)} — for a link that lasts, serve the file through a route of your own.`);
  }
  return whole;
}

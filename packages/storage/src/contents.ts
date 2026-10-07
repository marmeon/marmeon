import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import type { ReadableStream as NodeWebStream } from 'node:stream/web';
import { durationToMilliseconds, type Duration } from '@marmeon/core';
import type { FileContents } from './disk.ts';

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

/** Seconds of a `number | Duration`, rounded up; refuses zero, negative and non-finite spans. */
export function secondsOf(expiresIn: number | Duration): number {
  const seconds = typeof expiresIn === 'number' ? expiresIn : durationToMilliseconds(expiresIn) / 1000;
  if (!Number.isFinite(seconds) || seconds <= 0) throw new RangeError(`expiresIn must be a positive time span, not ${JSON.stringify(expiresIn)}.`);
  return Math.ceil(seconds);
}

import { createHash } from 'node:crypto';
import type { ImportS3, S3Modules } from '../drivers/s3.ts';

interface StoredObject {
  bytes: Uint8Array;
  contentType: string;
  etag: string;
  modified: Date;
}

const CHUNK = 64 * 1024;

const failure = (name: string, status: number) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });

/**
 * An S3 store in memory behind the SDK's command interface: objects with ETags, conditional reads and copies (412), and a
 * record of what was sent — `calls`, and the biggest chunk any `PutObject` body arrived in.
 */
export class FakeS3 {
  readonly objects = new Map<string, StoredObject>();
  readonly calls: { command: string; input: Record<string, unknown> }[] = [];
  biggestPutChunk = 0;
  /** Runs before each `GetObject` is answered — a test swaps the object here. */
  beforeGet: (() => void) | undefined;
  /** Answers `HeadObject` without an ETag. */
  headWithoutEtag = false;
  readonly load: ImportS3;
  #writes = 0;

  constructor() {
    const fake = this;
    const command = (name: string) =>
      ({
        [name]: class {
          readonly input: Record<string, unknown>;
          constructor(input: Record<string, unknown>) {
            this.input = input;
          }
        },
      })[name]!;
    const commands = Object.fromEntries(['HeadObject', 'GetObject', 'PutObject', 'CopyObject', 'DeleteObject', 'ListObjectsV2'].map((name) => [`${name}Command`, command(`${name}Command`)]));
    class S3Client {
      send(sent: { constructor: { name: string }; input: Record<string, unknown> }) {
        return fake.#answer(sent.constructor.name.replace(/Command$/, ''), sent.input);
      }
      destroy() {}
    }
    const modules = { client: { ...commands, S3Client }, presigner: {} } as unknown as S3Modules;
    this.load = async () => modules;
  }

  /** What a browser's POST to the policy does: writes the object — a second POST replaces it. */
  post(bucket: string, key: string, bytes: Uint8Array, contentType = 'application/octet-stream'): void {
    this.#write(`${bucket}/${key}`, bytes, contentType);
  }

  calledWith(command: string): Record<string, unknown>[] {
    return this.calls.filter((call) => call.command === command).map((call) => call.input);
  }

  #write(id: string, bytes: Uint8Array, contentType: string): void {
    // Equal bytes written twice still get two ETags here; a real store gives the same one (and then nothing changed).
    const etag = `"${createHash('md5').update(bytes).update(String(this.#writes++)).digest('hex')}"`;
    this.objects.set(id, { bytes, contentType, etag, modified: new Date() });
  }

  #find(id: string, ifMatch: unknown): StoredObject {
    const object = this.objects.get(id);
    if (!object) throw failure('NoSuchKey', 404);
    if (typeof ifMatch === 'string' && ifMatch !== object.etag) throw failure('PreconditionFailed', 412);
    return object;
  }

  async #answer(command: string, input: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ command, input });
    const id = `${String(input.Bucket)}/${String(input.Key)}`;
    switch (command) {
      case 'HeadObject': {
        const object = this.#find(id, undefined);
        return { ETag: this.headWithoutEtag ? undefined : object.etag, ContentLength: object.bytes.byteLength, ContentType: object.contentType, LastModified: object.modified };
      }
      case 'GetObject': {
        this.beforeGet?.();
        const object = this.#find(id, input.IfMatch);
        const range = /^bytes=0-(\d+)$/.exec(String(input.Range ?? ''));
        const bytes = range ? object.bytes.subarray(0, Number(range[1]) + 1) : object.bytes;
        const stream = () =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (let at = 0; at < bytes.byteLength; at += CHUNK) controller.enqueue(bytes.subarray(at, at + CHUNK));
              controller.close();
            },
          });
        return {
          Body: { transformToWebStream: stream, transformToByteArray: async () => new Uint8Array(bytes) },
          ETag: object.etag,
          ContentLength: bytes.byteLength,
          ContentType: object.contentType,
          LastModified: object.modified,
        };
      }
      case 'PutObject': {
        const body = input.Body;
        const chunks: Uint8Array[] = [];
        if (typeof body === 'string') chunks.push(new TextEncoder().encode(body));
        else if (body instanceof Uint8Array) chunks.push(body);
        else for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(chunk);
        for (const chunk of chunks) this.biggestPutChunk = Math.max(this.biggestPutChunk, chunk.byteLength);
        const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
        let at = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, at);
          at += chunk.byteLength;
        }
        this.#write(id, bytes, String(input.ContentType));
        return {};
      }
      case 'CopyObject': {
        const object = this.#find(decodeURIComponent(String(input.CopySource)), input.CopySourceIfMatch);
        this.#write(id, object.bytes, input.MetadataDirective === 'REPLACE' ? String(input.ContentType) : object.contentType);
        return {};
      }
      case 'DeleteObject':
        this.objects.delete(id);
        return {};
      default:
        throw new Error(`The fake store does not know ${command}.`);
    }
  }
}

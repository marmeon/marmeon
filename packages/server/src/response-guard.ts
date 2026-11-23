import type { RequestListener, ServerResponse } from 'node:http';

/** What Node keeps on a response and the guard sets for one thing only: closing the connection after a response whose head went out. */
interface Announced {
  /** True when the connection ends after this response. */
  _last?: unknown;
}

const FRAMING = new Set(['content-length', 'transfer-encoding', 'trailer']);

/**
 * The adapter's listener with what it leaves open when a body fails or runs past its length: a response queued behind another
 * takes its connection along, as does one that ends short of its length, no byte follows the announced length, and a response the
 * adapter gave up on is answered. The text of an error is never sent for the bodies the kernel hands the adapter. A response that
 * can be read correctly is not touched.
 * `report` is given the error of a listener that rejected.
 */
export function guarded(listener: RequestListener, report?: (error: unknown) => void): RequestListener {
  return async (request, response) => {
    guardResponse(response);
    try {
      await listener(request, response);
    } catch (error) {
      try {
        report?.(error);
      } catch {
        // A report that fails must not end the process.
      }
      refuse(response, true);
      return;
    }
    // Every answer of the adapter has its head by now. For some errors of a body it writes none and leaves the request open.
    if (!response.headersSent && !response.destroyed) refuse(response, false);
  };
}

/** A whole `500` while no head is out, else the connection goes. `close` ends the connection after it. */
function refuse(response: ServerResponse, close: boolean): void {
  if (response.headersSent || response.destroyed) return void response.destroy();
  try {
    if (close) response.shouldKeepAlive = false;
    response.writeHead(500, { 'content-length': '0' }).end();
  } catch {
    response.destroy();
  }
}

/**
 * The headers of one answer with the framing taken out: `Content-Length`, `Transfer-Encoding` and `Trailer` of a route are not
 * Node's to trust. One `Content-Length` stays when every value of it is the same whole number and no `Transfer-Encoding` came
 * with it; otherwise Node frames the body itself.
 */
function framed(headers: Record<string, unknown>): { headers: Record<string, unknown>; length: number | null } {
  const copy: Record<string, unknown> = {};
  const lengths: string[] = [];
  let transferred = false;
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!FRAMING.has(lower)) {
      copy[name] = value;
      continue;
    }
    if (lower === 'transfer-encoding') transferred = true;
    // An array of values counts as its values joined by commas.
    if (lower === 'content-length') lengths.push(...String(value).split(',').map((part) => part.trim()));
  }
  let held: number | null = null;
  if (!transferred && lengths.length > 0 && lengths.every((part) => /^\d+$/.test(part))) {
    const length = Number(lengths[0]);
    if (Number.isSafeInteger(length) && lengths.every((part) => Number(part) === length)) {
      copy['content-length'] = String(length);
      held = length;
    }
  }
  return { headers: copy, length: held };
}

function guardResponse(response: ServerResponse): void {
  const { write, end, writeHead, flushHeaders } = response;
  // What the guard knows from the head it let through, not from fields of Node: the length it sent, and whether the response has a body.
  let announcedLength: number | null = null;
  let hasBody = true;
  /** The length the body is held to: only for a response that has a body and names a length. */
  const heldTo = (): number | null => {
    if (!hasBody) return null;
    if (announcedLength !== null) return announcedLength;
    // A length Node sends from its own field when the guard found none: it can only tighten the hold, and a missing field drops this alone.
    const own = (response as { _contentLength?: unknown })._contentLength;
    return typeof own === 'number' && Number.isSafeInteger(own) && own >= 0 ? own : null;
  };
  let started = false;
  let written = 0;
  let errorHead = false;
  let cut = false;
  let ended = false;
  // Destroyed while queued it had no socket to destroy. One that was ended before is whole: it goes out, then the connection
  // ends, as Node releases no next response after a destroyed one.
  response.on('socket', (socket) => {
    if (!response.destroyed) return;
    if (ended) process.nextTick(() => socket.destroySoon());
    else socket.destroy();
  });
  response.writeHead = ((...args: unknown[]) => {
    const status = args[0];
    if (typeof status === 'number' && status < 200) throw new RangeError(`A response cannot be sent with the status ${status}.`);
    const headers = args.at(-1);
    hasBody = response.req?.method !== 'HEAD' && status !== 204 && status !== 304;
    const record = typeof headers === 'object' && headers !== null && !Array.isArray(headers) ? (headers as Record<string, unknown>) : undefined;
    // What was set before the head counts as well: the adapter sets headers on the response first when a layer above did.
    const given = record ?? {};
    const givenNames = new Set(Object.keys(given).map((name) => name.toLowerCase()));
    const preset: Record<string, unknown> = {};
    for (const name of FRAMING) {
      const value = response.getHeader(name);
      if (value !== undefined && !givenNames.has(name)) preset[name] = value;
    }
    const all = { ...preset, ...given };
    // The adapter's head for a failed body: a 500 without a length. A 500 that carries a Content-Length is the app's own answer. Judged before framed(), which can take a length off.
    // The adapter marks its error head with `_contentLength = null` before it writes it, and sets the length of a whole string body itself: nothing else tells the two apart.
    errorHead = status === 500 && (response as { _contentLength?: unknown })._contentLength === null && !Object.keys(all).some((name) => name.toLowerCase() === 'content-length');
    announcedLength = null;
    // A list of headers is Node's own business: no length is held for it.
    if (Array.isArray(headers) || (record === undefined && Object.keys(preset).length === 0)) return Reflect.apply(writeHead, response, args);
    const framing = framed(all);
    announcedLength = framing.length;
    for (const name of Object.keys(preset)) response.removeHeader(name);
    const rest = record === undefined ? (typeof args[1] === 'string' ? args : args.slice(0, 1)) : args.slice(0, -1);
    return Reflect.apply(writeHead, response, [...rest, framing.headers]);
  }) as typeof writeHead;
  response.flushHeaders = () => {
    started = true;
    flushHeaders.call(response);
  };
  /** Sends `chunk` up to the length and ends the response: a client reads exactly these bytes of such a response anyway. */
  const cutAt = (length: number, chunk: string | Uint8Array, encoding: BufferEncoding | undefined) => {
    cut = true;
    ended = true;
    const room = length - written;
    if (room > 0) Reflect.apply(end, response, [Buffer.from(chunk as string, encoding).subarray(0, room)]);
    else Reflect.apply(end, response, []);
  };
  response.write = ((...args: unknown[]) => {
    if (cut) return false;
    started = true;
    const chunk = args[0] as string | Uint8Array;
    const encoding = typeof args[1] === 'string' ? (args[1] as BufferEncoding) : undefined;
    const size = Buffer.byteLength(chunk, encoding);
    const length = heldTo();
    if (length !== null && written + size > length) {
      cutAt(length, chunk, encoding);
      return false;
    }
    written += size;
    return Reflect.apply(write, response, args);
  }) as typeof write;
  response.end = ((...args: unknown[]) => {
    if (cut) return response;
    const chunk = args[0] && typeof args[0] !== 'function' ? (args[0] as string | Uint8Array) : undefined;
    // The adapter ends a streamed body without a chunk: a chunk it gives then is the text of the error.
    if (chunk !== undefined && started) return response.destroy();
    // The adapter's error head carries no body of its own either.
    if (chunk !== undefined && errorHead) {
      if (!response.destroyed) ended = true;
      return Reflect.apply(end, response, []);
    }
    const encoding = typeof args[1] === 'string' ? (args[1] as BufferEncoding) : undefined;
    const length = heldTo();
    if (length !== null && !response.destroyed) {
      const total = written + (chunk === undefined ? 0 : Buffer.byteLength(chunk, encoding));
      if (total > length) {
        cutAt(length, chunk!, encoding);
        return response;
      }
      if (total < length) {
        // A body that ends short of its length cannot be read: the connection goes with it. With no byte written, the head still
        // goes out, as a proxy that replaces the body reads it, and then the connection closes: Node ends it after this response.
        if (!started && chunk === undefined && typeof (response as Announced)._last === 'boolean') {
          (response as Announced)._last = true;
          ended = true;
          return Reflect.apply(end, response, []);
        }
        return response.destroy();
      }
    }
    if (!response.destroyed) ended = true;
    return Reflect.apply(end, response, args);
  }) as typeof end;
}

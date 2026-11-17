import { lookup as dnsLookup } from 'node:dns/promises';
import { Agent as HttpAgent, request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest, type RequestOptions as HttpsRequestOptions } from 'node:https';
import type { LookupFunction } from 'node:net';
import { isIP } from 'node:net';
import { getCACertificates } from 'node:tls';
import { FetchError } from './errors.ts';
import { isPublic, parseAddress, type AddressRange } from './addresses.ts';

/** What the `direct` transport sends. */
export type DirectRequest = {
  readonly url: URL;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
  /** Aborts the request at any stage: name resolution, connect, response and body. */
  readonly signal?: AbortSignal;
};

/** What the `direct` transport returns: no redirect is followed and no body is decompressed. */
export type DirectResponse = {
  readonly status: number;
  readonly headers: Headers;
  readonly body: ReadableStream<Uint8Array>;
};

export type DirectOptions = {
  /** Ranges that may be reached although they are not public. */
  readonly allow: readonly AddressRange[];
  /** In milliseconds: `connect` covers name resolution and connect (default 5000), `response` the wait for the headers (default 10000). */
  readonly timeouts?: { readonly connect?: number; readonly response?: number };
  /** Certificates an https server may be trusted by in addition to the built-in authorities (a private authority). */
  readonly ca?: string;
  /** Resolves a name to its addresses. Defaults to the operating system's resolver, `/etc/hosts` included. */
  readonly resolve?: (host: string) => Promise<readonly string[]>;
};

const DEFAULT_CONNECT_TIMEOUT = 5_000;
const DEFAULT_RESPONSE_TIMEOUT = 10_000;

async function systemResolve(host: string): Promise<readonly string[]> {
  const answers = await dnsLookup(host, { all: true, verbatim: true });
  return answers.map((answer) => answer.address);
}

function refused(host: string, addresses: readonly string[]): FetchError {
  return new FetchError('refused', `The host "${host}" resolves to an address that is not public.`, { cause: { addresses } });
}

/** A lookup that answers with the checked addresses only, ignores DNS and fails for any other name. */
function pinnedLookup(host: string, addresses: readonly string[]): LookupFunction {
  const entries = addresses.map((address) => ({ address, family: isIP(address) }));
  return (name, options, callback) => {
    if (name !== host) {
      callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${name}`), { code: 'ENOTFOUND' }), '', 4);
      return;
    }
    if (options.all) {
      (callback as unknown as (error: null, all: typeof entries) => void)(null, entries);
      return;
    }
    callback(null, entries[0]!.address, entries[0]!.family);
  };
}

function toHeaders(response: IncomingMessage): Headers {
  const headers = new Headers();
  for (let index = 0; index + 1 < response.rawHeaders.length; index += 2) {
    try {
      headers.append(response.rawHeaders[index]!, response.rawHeaders[index + 1]!);
    } catch {
      // A header the platform refuses to represent is dropped.
    }
  }
  return headers;
}

/** The built-in authorities plus `extra`; `undefined` (Node's own list) without `extra`. A bare `ca` option would replace the built-in list. */
export function trustedAuthorities(extra: string | undefined): string[] | undefined {
  return extra === undefined ? undefined : [...getCACertificates('default'), extra];
}

const asFetchError = (error: unknown, message: string): FetchError => (error instanceof FetchError ? error : new FetchError('network', message, { cause: error }));

/**
 * Resolves the host once, checks every address and connects only to the checked ones, so a name that answers differently
 * a second time cannot reach another address. Throws a `FetchError` and nothing else, also for the body stream of the response.
 */
export async function send(request: DirectRequest, options: DirectOptions): Promise<DirectResponse> {
  const { url } = request;
  const stop = new AbortController();
  const aborted = () => new FetchError('aborted', 'The request was aborted.', { cause: request.signal?.reason });
  if (request.signal?.aborted) throw aborted();
  const secure = url.protocol === 'https:';
  if (!secure && url.protocol !== 'http:') throw new FetchError('refused', 'Only http and https addresses can be fetched.');
  if (url.username !== '' || url.password !== '') {
    throw new FetchError('refused', 'The address carries a user name or a password. Send credentials in a header instead.');
  }
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  const connectTimeout = options.timeouts?.connect ?? DEFAULT_CONNECT_TIMEOUT;
  const responseTimeout = options.timeouts?.response ?? DEFAULT_RESPONSE_TIMEOUT;
  const timeout = (message: string) => stop.abort(new FetchError('timeout', message));
  let timer: NodeJS.Timeout | undefined = setTimeout(() => timeout('The connection was not established in time.'), connectTimeout);
  const onCallerAbort = () => stop.abort(aborted());
  request.signal?.addEventListener('abort', onCallerAbort, { once: true });
  const release = () => {
    clearTimeout(timer);
    request.signal?.removeEventListener('abort', onCallerAbort);
  };
  const stopped = new Promise<never>((_, reject) => {
    stop.signal.addEventListener('abort', () => reject(stop.signal.reason), { once: true });
  });
  stopped.catch(() => {});

  try {
    let addresses: readonly string[];
    if (isIP(host) !== 0) {
      addresses = [host];
    } else {
      try {
        addresses = await Promise.race([(options.resolve ?? systemResolve)(host), stopped]);
      } catch (error) {
        throw asFetchError(error, `The host "${host}" could not be resolved.`);
      }
    }
    if (addresses.length === 0) throw new FetchError('network', `The host "${host}" could not be resolved.`);
    for (const text of addresses) {
      const address = parseAddress(text);
      if (!address || !isPublic(address, options.allow)) throw refused(host, addresses);
    }
    stop.signal.throwIfAborted();

    const agent = secure ? new HttpsAgent({ keepAlive: false }) : new HttpAgent({ keepAlive: false });
    // No prototype: a header named `__proto__` is a header, not the prototype setter.
    const headers: Record<string, string> = Object.create(null);
    for (const [name, value] of Object.entries(request.headers ?? {})) {
      const lower = name.toLowerCase();
      if (lower !== 'host' && lower !== 'accept-encoding') headers[lower] = value;
    }
    headers['accept-encoding'] = 'identity';
    // Node frames a body itself only for methods that usually carry one; a DELETE, GET or OPTIONS body would go out unframed.
    if (request.body !== undefined && headers['content-length'] === undefined && headers['transfer-encoding'] === undefined) {
      headers['content-length'] = String(Buffer.byteLength(request.body));
    }
    const requestOptions: HttpsRequestOptions = {
      host,
      port: url.port === '' ? undefined : Number(url.port),
      path: `${url.pathname}${url.search}`,
      method: request.method ?? 'GET',
      headers,
      agent,
      ca: trustedAuthorities(options.ca),
      lookup: pinnedLookup(host, addresses),
    };

    return await new Promise<DirectResponse>((resolve, reject) => {
      let outgoing: ClientRequest;
      try {
        outgoing = (secure ? httpsRequest : httpRequest)(requestOptions);
      } catch (error) {
        agent.destroy();
        reject(new FetchError('refused', 'The request cannot be sent: its method or a header is not valid.', { cause: error }));
        return;
      }
      let incoming: IncomingMessage | undefined;
      const onStop = () => {
        const reason = stop.signal.reason as FetchError;
        outgoing.destroy(reason);
        incoming?.destroy(reason);
        reject(reason);
      };
      stop.signal.addEventListener('abort', onStop, { once: true });
      outgoing.on('socket', (socket) => {
        const connected = () => {
          clearTimeout(timer);
          timer = setTimeout(() => timeout('The response did not arrive in time.'), responseTimeout);
        };
        // For https the connect deadline also covers the TLS handshake: a peer that accepts the TCP connection and stalls is not a response wait.
        if (secure) socket.once('secureConnect', connected);
        else if (socket.connecting) socket.once('connect', connected);
        else connected();
      });
      outgoing.once('error', (error) => reject(asFetchError(error, `The request to "${host}" failed.`)));
      // A `101` or a `200` to CONNECT is not a response here: the request just closes, and without this it would never settle.
      outgoing.once('close', () => {
        if (incoming === undefined) reject(new FetchError('network', `The request to "${host}" ended without a response.`));
      });
      outgoing.once('response', (response) => {
        incoming = response;
        clearTimeout(timer);
        const iterator = response[Symbol.asyncIterator]();
        const finish = () => {
          release();
          agent.destroy();
        };
        response.once('close', finish);
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const next = await iterator.next();
              if (next.done) controller.close();
              else controller.enqueue(next.value as Uint8Array);
            } catch (error) {
              controller.error(asFetchError(error, `The response from "${host}" was cut off.`));
            }
          },
          cancel() {
            response.destroy();
          },
        });
        resolve({ status: response.statusCode ?? 0, headers: toHeaders(response), body });
      });
      try {
        outgoing.end(request.body);
      } catch (error) {
        outgoing.destroy();
        reject(new FetchError('refused', 'The request cannot be sent: its body is not valid.', { cause: error }));
      }
    }).catch((error: unknown) => {
      agent.destroy();
      throw error;
    });
  } catch (error) {
    release();
    throw asFetchError(error, 'The request failed.');
  }
}

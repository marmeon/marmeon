import { FetchError, type HttpClient } from '@marmeon/fetch';
import type { OAuthHttp } from './definition.ts';
import { checkEndpoint } from './endpoints.ts';

const TIMEOUT_SECONDS = 10;
const DEFAULT_MAX_BYTES = 1024 * 1024;

/**
 * Why a request to a provider gave no usable answer. `status` is the HTTP status of a response that was not 2xx, and `0` for
 * everything else (no connection, a refused address, a redirect, a body too large or too slow, an answer that is no JSON). The
 * error never carries the body: a provider's error page is not for logs, users or the app.
 */
export class OAuthHttpError extends Error {
  readonly status: number;

  constructor(status: number, options?: { cause?: unknown }) {
    super(status === 0 ? 'The provider could not be reached, or did not answer with JSON.' : `The provider answered with status ${status}.`, options);
    this.name = 'OAuthHttpError';
    this.status = status;
  }
}

/**
 * The {@link OAuthHttp} a provider's `profile()` and discovery get: JSON requests through `client` — which refuses the addresses of
 * your own network unless the provider's `allowAddresses` lets them through — with a time limit, a size limit and no redirects.
 * `local` allows plain http to a loopback host. See docs/oauth.md#the-flow-and-its-security.
 */
export function createOAuthHttp(client: HttpClient, local: boolean): OAuthHttp {
  return {
    async json(url, init = {}) {
      // A bearer token goes to https only (and to loopback while developing), whatever address a provider's code passes.
      checkEndpoint(url, 'The address of an OAuth request', 'A10', local);
      let headers: Headers;
      try {
        headers = new Headers(init.headers);
        headers.set('accept', 'application/json');
        if (init.bearer !== undefined) headers.set('authorization', `Bearer ${init.bearer}`);
      } catch {
        // A fixed text: the engine's message quotes the value, and the value is a token.
        throw new TypeError('A header of the OAuth request is not valid: a header name or value, or the bearer token, holds a character a header cannot.');
      }
      let response: Response;
      try {
        response = await client.fetch(url, {
          method: init.method ?? (init.form === undefined ? 'GET' : 'POST'),
          headers,
          timeout: TIMEOUT_SECONDS,
          maxResponseBytes: init.maxBytes ?? DEFAULT_MAX_BYTES,
          // A redirect would carry the request, and with it the code or the token, to an address nobody checked.
          redirect: 'error',
          ...(init.form === undefined ? {} : { body: new URLSearchParams(init.form) }),
        });
      } catch (error) {
        if (error instanceof FetchError) throw new OAuthHttpError(0, { cause: error });
        throw error;
      }
      if (response.status < 200 || response.status > 299) {
        // The body is dropped unread, so the connection is released and no error page can reach a message.
        await response.body?.cancel().catch(() => undefined);
        throw new OAuthHttpError(response.status);
      }
      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        if (error instanceof FetchError) throw new OAuthHttpError(0, { cause: error });
        throw error;
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        // No cause: a SyntaxError quotes a piece of the body.
        throw new OAuthHttpError(0);
      }
    },
  };
}

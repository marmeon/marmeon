import { withCode } from '@marmeon/core/internal';
import type { ErrorCode } from '@marmeon/core';
import { OAuthSetupError } from './config.ts';
import type { OAuthEndpoints } from './definition.ts';

/** The parameters the flow sets itself; one that a provider sets would replace a protection (state, PKCE, nonce, the callback, the request object). */
export const RESERVED_PARAMS: readonly string[] = [
  'response_type', 'response_mode', 'client_id', 'redirect_uri', 'scope', 'state', 'code_challenge', 'code_challenge_method', 'nonce', 'prompt', 'max_age', 'request', 'request_uri',
];

/** An {@link OAuthSetupError} for an endpoint, with `reason`: which endpoint and why, in a fixed text that holds nothing of the address — safe for a log. */
export class EndpointError extends OAuthSetupError {
  readonly reason: string;
  /** What is wrong in a fixed text, without the endpoint's name. */
  readonly why: string;

  constructor(message: string, why: string, field?: string) {
    super(message);
    this.why = why;
    this.reason = field === undefined ? why : `${field}: ${why}`;
  }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Checks an endpoint the flow will send a code, a secret or a person to: absolute, without a user name or a fragment, and `https:`.
 * Plain `http:` is accepted only for a loopback host while developing or testing (`local` is `true` there). Throws
 * {@link OAuthSetupError} with `code`. See docs/oauth.md#your-own-provider.
 */
export function checkEndpoint(url: unknown, what: string, code: ErrorCode, local: boolean): URL {
  const refuse = (why: string): never => {
    throw new EndpointError(withCode(code, `${what} is not a usable endpoint: ${why}`), why);
  };
  if (typeof url !== 'string') return refuse('it must be a string.');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return refuse('it must be an absolute URL.');
  }
  if (parsed.username !== '' || parsed.password !== '') return refuse('it must not carry a user name or password.');
  if (parsed.hash !== '' || url.includes('#')) return refuse('it must not carry a fragment.');
  if (parsed.protocol === 'https:') return parsed;
  if (parsed.protocol === 'http:') {
    if (local && LOOPBACK.has(parsed.hostname)) return parsed;
    return refuse(local ? 'http is accepted only for localhost, 127.0.0.1 or [::1]; use https.' : 'it must use https (http is accepted for a loopback host only while developing or testing).');
  }
  return refuse('it must use https.');
}

/**
 * Checks the endpoints of a provider and returns them as a copy: addresses as `URL` writes them, the issuer exactly as given (an
 * ID token's issuer is compared as text). The query of the authorization address may not set a parameter the flow owns. Reads each
 * property once, so a getter cannot answer differently the second time.
 */
export function checkEndpoints(endpoints: unknown, where: string, code: ErrorCode, local: boolean): OAuthEndpoints {
  const fail = (why: string, reason: string): never => {
    throw new EndpointError(withCode(code, `${where} ${why}`), reason);
  };
  // The same refusal, with the name of the endpoint in its reason.
  const check = (value: unknown, field: string): URL => {
    try {
      return checkEndpoint(value, `${where}: ${field}`, code, local);
    } catch (error) {
      if (error instanceof EndpointError) throw new EndpointError(error.message, error.why, field);
      throw error;
    }
  };
  if (typeof endpoints !== 'object' || endpoints === null) return fail('needs endpoints: an object with authorizeUrl and tokenUrl, or a function that finds them.', 'endpoints: it must be an object with authorizeUrl and tokenUrl.');
  const { authorizeUrl, tokenUrl, issuer } = endpoints as Record<string, unknown>;
  const authorize = check(authorizeUrl, 'authorizeUrl');
  for (const key of authorize.searchParams.keys()) {
    if (RESERVED_PARAMS.includes(key.toLowerCase())) fail(`sets "${key}" in the query of authorizeUrl, but the flow sets it itself.`, 'authorizeUrl: its query sets a parameter that the flow sets itself.');
  }
  const token = check(tokenUrl, 'tokenUrl');
  if (issuer === undefined) return Object.freeze({ authorizeUrl: authorize.href, tokenUrl: token.href });
  check(issuer, 'issuer');
  return Object.freeze({ authorizeUrl: authorize.href, tokenUrl: token.href, issuer: issuer as string });
}

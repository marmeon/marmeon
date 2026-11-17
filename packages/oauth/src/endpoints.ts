import { withCode } from '@marmeon/core/internal';
import type { ErrorCode } from '@marmeon/core';
import { OAuthSetupError } from './config.ts';
import type { OAuthEndpoints } from './definition.ts';

/** The parameters the flow sets itself; one that a provider sets would replace a protection (state, PKCE, nonce, the callback, the request object). */
export const RESERVED_PARAMS: readonly string[] = [
  'response_type', 'response_mode', 'client_id', 'redirect_uri', 'scope', 'state', 'code_challenge', 'code_challenge_method', 'nonce', 'prompt', 'max_age', 'request', 'request_uri',
];

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Checks an endpoint the flow will send a code, a secret or a person to: absolute, without a user name or a fragment, and `https:`.
 * Plain `http:` is accepted only for a loopback host while developing or testing (`local` is `true` there). Throws
 * {@link OAuthSetupError} with `code`. See docs/oauth.md#your-own-provider.
 */
export function checkEndpoint(url: unknown, what: string, code: ErrorCode, local: boolean): URL {
  const refuse = (why: string): never => {
    throw new OAuthSetupError(withCode(code, `${what} is not a usable endpoint: ${why}`));
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
  const fail = (why: string): never => {
    throw new OAuthSetupError(withCode(code, `${where} ${why}`));
  };
  if (typeof endpoints !== 'object' || endpoints === null) return fail('needs endpoints: an object with authorizeUrl and tokenUrl, or a function that finds them.');
  const { authorizeUrl, tokenUrl, issuer } = endpoints as Record<string, unknown>;
  const authorize = checkEndpoint(authorizeUrl, `${where}: authorizeUrl`, code, local);
  for (const key of authorize.searchParams.keys()) {
    if (RESERVED_PARAMS.includes(key.toLowerCase())) fail(`sets "${key}" in the query of authorizeUrl, but the flow sets it itself.`);
  }
  const token = checkEndpoint(tokenUrl, `${where}: tokenUrl`, code, local);
  if (issuer === undefined) return Object.freeze({ authorizeUrl: authorize.href, tokenUrl: token.href });
  checkEndpoint(issuer, `${where}: issuer`, code, local);
  return Object.freeze({ authorizeUrl: authorize.href, tokenUrl: token.href, issuer: issuer as string });
}

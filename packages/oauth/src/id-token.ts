import { err, ok, type Result } from '@marmeon/core';
import { same } from './same.ts';

/** The claims of an ID token that passed the checks. `sub` and `iss` are always there. */
export type IdTokenClaims = Readonly<Record<string, unknown>> & { readonly sub: string; readonly iss: string };

/** What an ID token is checked against. */
export interface IdTokenExpectations {
  /** The issuers the token may name, each compared as exact text; told the (unchecked) claims, as the answer may depend on them. */
  readonly issuers: (claims: Readonly<Record<string, unknown>>) => readonly string[];
  readonly clientId: string;
  /** The nonce of this flow. */
  readonly nonce: string;
  /** Milliseconds since the epoch. */
  readonly now: number;
}

/** How far the clocks of the provider and of this server may differ, in seconds. */
const TOLERANCE = 60;
const MAX_SUB = 255;
const PART = /^[A-Za-z0-9_-]+$/;
const SIGNATURE = /^[A-Za-z0-9_-]*$/;

/** A JSON object from a base64url part, or `undefined`. */
function objectOf(part: string): Record<string, unknown> | undefined {
  if (!PART.test(part)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(part, 'base64url')));
  } catch {
    return undefined;
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * Checks the ID token of a token response the way OpenID Connect Core 3.1.3.7 asks, and answers its claims, or a fixed `kind` (the check that failed) that
 * holds nothing of the token. The checks: the form (three parts, a JSON object as payload), `iss` is one of the issuers exactly,
 * `aud` holds the client id (and `azp` names this client, and is there when `aud` has several entries), `exp`, `iat` and `nbf` fit the
 * time within one minute, `nonce` is the one of this flow, and `sub` is 1 to 255 characters.
 *
 * Invariant: the signature is not checked, and `alg` is read for nothing. The token came straight from the token endpoint, which this
 * server called over TLS with its own client secret, and OpenID Connect Core 3.1.3.7 point 6 lets the client trust that channel in place
 * of the signature. A token that reaches this function any other way (from the browser, say) must never be checked with it.
 * See docs/oauth.md#openid-connect-providers.
 */
export function checkIdToken(token: string, expected: IdTokenExpectations): Result<IdTokenClaims, { readonly kind: string }> {
  const refuse = (reason: string): Result<never, { readonly kind: string }> => err({ kind: reason });
  const parts = token.split('.');
  if (parts.length !== 3 || !SIGNATURE.test(parts[2]!)) return refuse('form');
  // The header is parsed to be sure it is a token, and read for nothing.
  if (objectOf(parts[0]!) === undefined) return refuse('header');
  const payload = objectOf(parts[1]!);
  if (payload === undefined) return refuse('payload');
  const { iss, sub, aud, azp, exp, iat, nbf, nonce } = payload;

  if (typeof iss !== 'string') return refuse('iss');
  let issuers: unknown;
  try {
    issuers = expected.issuers(Object.freeze({ ...payload }));
  } catch {
    return refuse('iss');
  }
  if (!Array.isArray(issuers) || !issuers.includes(iss)) return refuse('iss');
  if (typeof sub !== 'string' || sub.length < 1 || sub.length > MAX_SUB) return refuse('sub');

  const audiences: unknown = Array.isArray(aud) ? aud : [aud];
  if (!Array.isArray(audiences) || !audiences.every((entry) => typeof entry === 'string') || !audiences.includes(expected.clientId)) return refuse('aud');
  // Several audiences: the token is also meant for others, so it must say which party it was issued to.
  if (audiences.length > 1 && azp === undefined) return refuse('azp');
  if (azp !== undefined && azp !== expected.clientId) return refuse('azp');

  const now = expected.now / 1000;
  if (!isNumber(exp) || exp <= now - TOLERANCE) return refuse('exp');
  if (!isNumber(iat) || iat > now + TOLERANCE) return refuse('iat');
  if (nbf !== undefined && (!isNumber(nbf) || nbf > now + TOLERANCE)) return refuse('nbf');

  if (typeof nonce !== 'string' || !same(nonce, expected.nonce)) return refuse('nonce');

  return ok(Object.freeze({ ...payload, iss, sub }) as IdTokenClaims);
}

import { FetchError } from '@marmeon/fetch';
import { err, ok, type Result } from '@marmeon/core';
import type { OAuthHttp, OAuthTokens } from './definition.ts';
import { OAuthHttpError } from './http.ts';

/** Why the token endpoint gave no tokens: it could not be reached, it refused the code, or its answer is not a token response. */
export type ExchangeError = { readonly kind: 'unavailable' } | { readonly kind: 'rejected' } | { readonly kind: 'invalid-response' };

/** What the token request is made of. */
export interface ExchangeInput {
  readonly http: OAuthHttp;
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly clientAuth: 'client_secret_post' | 'client_secret_basic';
  readonly redirectUri: string;
  readonly code: string;
  /** The PKCE verifier of the flow; a flow without PKCE has none. */
  readonly verifier: string | undefined;
  /** The scopes that were asked for: what the tokens are taken to cover when the provider does not say. */
  readonly asked: readonly string[];
  /** Milliseconds since the epoch. */
  readonly now: number;
}

const MAX_BYTES = 256 * 1024;
const MAX_TOKEN_LENGTH = 16 * 1024;

/** RFC 6749 section 2.3.1: form-urlencoding of a credential before it goes into the Basic header. */
const formEncoded = (value: string): string => new URLSearchParams({ v: value }).toString().slice(2);

/** `text` when it is a non-empty string of a reasonable length, else `undefined`. */
const textOf = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' && value.length <= MAX_TOKEN_LENGTH ? value : undefined);

/**
 * Trades the code for tokens at the token endpoint. The answer is untrusted: only a token response of the shape RFC 6749 gives is
 * accepted, and no error carries a body, a status text or anything the provider wrote.
 */
export async function exchangeCode(input: ExchangeInput): Promise<Result<OAuthTokens, ExchangeError>> {
  const form: Record<string, string> = {
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    ...(input.verifier === undefined ? {} : { code_verifier: input.verifier }),
    client_id: input.clientId,
  };
  const headers: Record<string, string> = {};
  if (input.clientAuth === 'client_secret_basic') {
    headers.authorization = `Basic ${Buffer.from(`${formEncoded(input.clientId)}:${formEncoded(input.clientSecret)}`).toString('base64')}`;
  } else {
    form.client_secret = input.clientSecret;
  }
  let body: unknown;
  try {
    body = await input.http.json(input.tokenUrl, { method: 'POST', form, headers, maxBytes: MAX_BYTES });
  } catch (error) {
    if (!(error instanceof OAuthHttpError)) throw error;
    return err(failureOf(error));
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return err({ kind: 'invalid-response' });
  const answer = body as Record<string, unknown>;
  // A provider that answers 200 with an error is still a refusal.
  if (answer.error !== undefined) return err({ kind: 'rejected' });
  const accessToken = textOf(answer.access_token);
  if (accessToken === undefined) return err({ kind: 'invalid-response' });
  if (typeof answer.token_type !== 'string' || answer.token_type.toLowerCase() !== 'bearer') return err({ kind: 'invalid-response' });
  const lifetime = typeof answer.expires_in === 'string' && /^\d{1,10}$/.test(answer.expires_in) ? Number(answer.expires_in) : answer.expires_in;
  const refreshToken = textOf(answer.refresh_token);
  const idToken = textOf(answer.id_token);
  return ok({
    accessToken,
    ...(refreshToken === undefined ? {} : { refreshToken }),
    ...(typeof lifetime === 'number' && Number.isFinite(lifetime) && lifetime > 0 && lifetime <= 10 * 365 * 86_400 ? { expiresAt: input.now + lifetime * 1000 } : {}),
    scopes: typeof answer.scope === 'string' ? answer.scope.split(/[\s,]+/).filter((scope) => scope !== '') : [...input.asked],
    ...(idToken === undefined ? {} : { idToken }),
  });
}

/** What a failed request to the provider means: a server that could not answer, a refusal, or an answer that is no JSON. */
export function failureOf(error: OAuthHttpError): ExchangeError {
  if (error.status >= 500) return { kind: 'unavailable' };
  if (error.status === 0) return error.cause instanceof FetchError ? { kind: 'unavailable' } : { kind: 'invalid-response' };
  return { kind: 'rejected' };
}

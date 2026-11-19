import { Clock, EnvironmentConfig, type Clock as ClockType, type Resolver } from '@marmeon/core';
import { flowKey, type OpenFlow } from '../flow.ts';
import type { OAuthProviderDefinition } from '../definition.ts';
import { oidc, type OidcOptions } from '../oidc.ts';
import { oauthWith, type FakeSession, type Parts } from './flow.ts';
import { tokenResponse } from './callback.ts';

export const ISSUER = 'https://idp.example.com';
export const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
export const TOKEN_URL = `${ISSUER}/token`;
export const USERINFO_URL = `${ISSUER}/userinfo`;
/** The time the tests run at, in milliseconds (the clock of `oauthWith`). */
export const NOW = 1_700_000_000_000;

const base64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

/** An ID token of the form a provider sends. Its claims are good for the client `client` and the flow with `nonce`; `claims` adds, replaces or (a value `undefined`) removes a claim. The signature is nonsense: nothing checks it. */
export function idToken(claims: Record<string, unknown> = {}, header: Record<string, unknown> = { alg: 'RS256', typ: 'JWT' }): string {
  const payload: Record<string, unknown> = { iss: ISSUER, sub: 'user-1', aud: 'client', exp: NOW / 1000 + 300, iat: NOW / 1000 - 5, nonce: 'n', ...claims };
  for (const key of Object.keys(payload)) if (payload[key] === undefined) delete payload[key];
  return `${base64url(header)}.${base64url(payload)}.c2ln`;
}

/** The discovery document of `ISSUER`; `extra` adds, replaces or (a value `undefined`) removes a field. */
export function discoveryDocument(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const document: Record<string, unknown> = { issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: TOKEN_URL, userinfo_endpoint: USERINFO_URL, ...extra };
  for (const key of Object.keys(document)) if (document[key] === undefined) delete document[key];
  return document;
}

/** The context a factory is given, with a container that holds the clock (looked up when it is first needed) and a test environment. */
export function contextOf(clock: () => ClockType, name = 'idp', issuer: string | undefined = undefined, node = 'test') {
  const container = {
    make: (key: unknown) => (key === Clock ? clock() : key === EnvironmentConfig ? { node } : undefined),
  } as unknown as Resolver;
  return { name, credentials: { clientId: 'client', clientSecret: 'secret', redirectUrl: undefined, scopes: undefined, issuer, options: {} }, container };
}

/** An `OAuth` over one provider `idp` built by `oidc(options)`, whose discovery is answered. `parts` is what `oauthWith` takes. */
export function oidcWith(options: OidcOptions = {}, parts: Parts = {}, document: Record<string, unknown> = discoveryDocument(), node = 'test') {
  let made: ReturnType<typeof oauthWith> | undefined;
  const definition = oidc({ issuer: ISSUER, ...options })(contextOf(() => made!.clock, 'idp', undefined, node)) as OAuthProviderDefinition;
  made = oauthWith({ ...parts, overrides: { ...parts.overrides, ...definition }, builtFrom: definition });
  made.http.respond(DISCOVERY_URL, () => Response.json(document));
  const session = made.session as FakeSession;
  /** Opens a flow, answers the token request with `response` (the ID token has the nonce of the flow unless it says one), and returns the callback query. */
  const begin = async (response: (flow: OpenFlow) => Response = (flow) => tokenResponse({ id_token: idToken({ nonce: flow.nonce }) })) => {
    const redirect = await made.oauth.redirect('idp');
    if (!redirect.ok) throw new Error('expected a flow');
    const flow = session.data.get(flowKey('idp')) as OpenFlow;
    made.http.respond(TOKEN_URL, () => response(flow));
    return { flow, redirect: redirect.value, query: new URLSearchParams({ code: 'the-code', state: flow.state }) };
  };
  return { ...made, session, definition, begin };
}

import { readFileSync } from 'node:fs';
import { Clock, EnvironmentConfig, type Resolver } from '@marmeon/core';
import type { Clock as ClockType } from '@marmeon/core';
import { flowKey, type OpenFlow } from '../flow.ts';
import type { OAuthProviderDefinition, OAuthProviderFactory } from '../definition.ts';
import { tokenResponse } from './callback.ts';
import { oauthWith, type FakeSession, type Parts } from './flow.ts';

/** An invented profile from `__fixtures__/profiles`. */
export const fixture = <T = Record<string, unknown>>(name: string): T => JSON.parse(readFileSync(new URL(`../__fixtures__/profiles/${name}.json`, import.meta.url), 'utf8')) as T;

export interface BuiltinOptions {
  /** Where the provider's token endpoint is. */
  readonly tokenUrl: string;
  readonly issuer?: string | undefined;
  readonly options?: Readonly<Record<string, string | undefined>>;
  /** Answers a GET of this address with this document (the discovery of an OpenID Connect provider). */
  readonly document?: { readonly url: string; readonly body: Record<string, unknown> };
}

/** The context a built-in factory is given: the credentials of an app that sets only the two variables, plus `issuer` and `options`. */
export function builtinContext(clock: () => ClockType, name: string, options: Partial<BuiltinOptions> = {}) {
  const container = { make: (key: unknown) => (key === Clock ? clock() : key === EnvironmentConfig ? { node: 'test' } : undefined) } as unknown as Resolver;
  return { name, credentials: { clientId: 'client', clientSecret: 'secret', redirectUrl: undefined, scopes: undefined, issuer: options.issuer, options: options.options ?? {} }, container };
}

/** An `OAuth` over the built-in provider `name`, built by `factory`; the flow's `begin` answers the token request with `response`. */
export function builtinWith(factory: OAuthProviderFactory, name: string, options: BuiltinOptions, parts: Parts = {}) {
  let made: ReturnType<typeof oauthWith> | undefined;
  const definition = factory(builtinContext(() => made!.clock, name, options)) as OAuthProviderDefinition;
  made = oauthWith({ ...parts, name, overrides: { ...parts.overrides, ...definition } });
  if (options.document !== undefined) made.http.respond(options.document.url, () => Response.json(options.document!.body));
  const session = made.session as FakeSession;
  /** Starts a flow of `intent`, wires the token endpoint to `response`, and gives the callback query. */
  const begin = async (response: (flow: OpenFlow) => Response, intent?: 'confirm', account = 'user-1') => {
    const redirect = intent === undefined ? await made.oauth.redirect(name) : await made.oauth.redirect(name, { intent, userId: 7, account });
    if (!redirect.ok) throw new Error(`expected a flow, got ${redirect.error.kind}`);
    const flow = session.data.get(flowKey(name)) as OpenFlow;
    made.http.respond(options.tokenUrl, () => response(flow));
    return { flow, redirect: redirect.value, query: new URLSearchParams({ code: 'the-code', state: flow.state }) };
  };
  return { ...made, session, definition, begin };
}

export { tokenResponse };

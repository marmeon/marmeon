import { Application, EnvironmentConfig, type Container, type ServiceProviderClass } from '@marmeon/core';
import { collectDrivers, withCode } from '@marmeon/core/internal';
import { HttpClient } from '@marmeon/fetch';
import { OAuthConfig, OAuthSetupError } from './config.ts';
import { credentialsOf, MAX_NAME_LENGTH, variablePrefix, type OAuthCredentials, type OAuthCredentialsConfig } from './credentials.ts';
import type { OAuthProviderDefinition, OAuthProviderFactory } from './definition.ts';
import { checkEndpoint, checkEndpoints, RESERVED_PARAMS } from './endpoints.ts';
import { ISSUER_PARAM, OIDC, type OidcDefinition } from './oidc-marker.ts';

/** An active provider: its definition and the credentials it needs, both checked at the start and frozen. */
export interface ResolvedOAuthProvider {
  readonly name: string;
  readonly label: string;
  readonly definition: OAuthProviderDefinition;
  readonly credentials: OAuthCredentials & { readonly clientId: string; readonly clientSecret: string };
}

/**
 * The providers that are active: the ones whose variables are set. A provider without them does not exist for the app — its
 * factory never runs, and `get()` answers `undefined` for it. See docs/oauth.md#configuring-a-provider.
 */
export class OAuthProviders {
  readonly #providers: ReadonlyMap<string, ResolvedOAuthProvider>;

  /** @internal Built at the start. */
  constructor(providers: readonly ResolvedOAuthProvider[]) {
    this.#providers = new Map(providers.map((provider) => [provider.name, provider]));
  }

  /** The active provider `name`, or `undefined` when it is unknown or has no client id and secret (or no issuer, where one is required). */
  get(name: string): ResolvedOAuthProvider | undefined {
    return this.#providers.get(name);
  }

  /** The active providers, in the order they were registered — what a sign-in page lists. */
  active(): readonly { readonly name: string; readonly label: string }[] {
    return [...this.#providers.values()].map(({ name, label }) => ({ name, label }));
  }
}

const refuse = (message: string, cause?: unknown): never => {
  throw new OAuthSetupError(withCode('A11', message), cause === undefined ? undefined : { cause });
};

const KEYS = ['label', 'endpoints', 'scopes', 'scopeSeparator', 'pkce', 'nonce', 'clientAuth', 'authorizeParams', 'allowAddresses', 'profile', 'mapUser'] as const;

const isStrings = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every((entry) => typeof entry === 'string');
const isScope = (scope: unknown): boolean => typeof scope === 'string' && scope !== '' && !/\s/.test(scope);

/**
 * The definition a factory returned, checked and copied. Each property is read once, a list or record is copied before it is
 * checked, and the result is frozen: a getter that answers differently the second time, or an object changed after the start,
 * cannot change what is kept. A plain object may hold the fields of a definition only; an instance of a class may hold more
 * (the state its `profile()` and `mapUser()` use). `local` allows a plain-http loopback endpoint. An endpoint that is a function
 * is kept as it is; nothing checks what it returns yet.
 */
function checkDefinition(name: string, definition: unknown, local: boolean): OAuthProviderDefinition {
  const where = `The OAuth provider "${name}"`;
  if (typeof definition !== 'object' || definition === null) return refuse(`${where} must create a definition object — use defineOAuthProvider({ label, endpoints, scopes, profile, mapUser }).`);
  const prototype: unknown = Object.getPrototypeOf(definition);
  const plain = prototype === Object.prototype || prototype === null;
  const extra = plain ? Object.keys(definition).filter((key) => !(KEYS as readonly string[]).includes(key)) : [];
  if (extra.length > 0) refuse(`${where} has a field that is not part of a definition: ${extra.map((key) => `"${key}"`).join(', ')}. The fields are ${KEYS.join(', ')}.`);
  const d = Object.fromEntries(KEYS.map((key) => [key, (definition as Record<string, unknown>)[key]])) as Partial<Record<(typeof KEYS)[number], unknown>>;

  if (typeof d.label !== 'string' || d.label.length < 1 || d.label.length > 64) refuse(`${where} needs a label of 1 to 64 characters.`);
  const endpoints = typeof d.endpoints === 'function' ? (d.endpoints as OAuthProviderDefinition['endpoints']) : checkEndpoints(d.endpoints, where, 'A11', local);
  const scopes: unknown = Array.isArray(d.scopes) ? [...d.scopes] : d.scopes;
  if (!Array.isArray(scopes) || !scopes.every(isScope)) refuse(`${where} needs scopes: a list of non-empty strings without spaces (one scope each).`);
  if (d.scopeSeparator !== undefined && (typeof d.scopeSeparator !== 'string' || d.scopeSeparator === '')) refuse(`${where}: scopeSeparator must be a non-empty string.`);
  if (d.pkce !== undefined && typeof d.pkce !== 'boolean') refuse(`${where}: pkce must be true or false.`);
  if (d.nonce !== undefined && typeof d.nonce !== 'boolean') refuse(`${where}: nonce must be true or false.`);
  if (d.clientAuth !== undefined && d.clientAuth !== 'client_secret_post' && d.clientAuth !== 'client_secret_basic') {
    refuse(`${where}: clientAuth must be 'client_secret_post' or 'client_secret_basic'.`);
  }
  let authorizeParams: Readonly<Record<string, string>> | undefined;
  if (d.authorizeParams !== undefined) {
    const params: unknown = typeof d.authorizeParams === 'object' && d.authorizeParams !== null && !Array.isArray(d.authorizeParams) ? { ...d.authorizeParams } : d.authorizeParams;
    if (typeof params !== 'object' || params === null || Array.isArray(params) || Object.values(params).some((value) => typeof value !== 'string')) {
      refuse(`${where}: authorizeParams must be an object of strings.`);
    }
    for (const key of Object.keys(params as object)) {
      if (RESERVED_PARAMS.includes(key.toLowerCase())) refuse(`${where}: authorizeParams cannot set "${key}" — the flow sets it. Reserved: ${RESERVED_PARAMS.join(', ')}.`);
    }
    authorizeParams = Object.freeze(params as Record<string, string>);
  }
  const allowAddresses: unknown = Array.isArray(d.allowAddresses) ? [...d.allowAddresses] : d.allowAddresses;
  if (allowAddresses !== undefined && !isStrings(allowAddresses)) refuse(`${where}: allowAddresses must be a list of strings.`);
  if (typeof d.profile !== 'function') refuse(`${where} needs a profile() function that loads the person's data.`);
  if (typeof d.mapUser !== 'function') refuse(`${where} needs a mapUser() function that turns that data into a profile.`);
  const profile = d.profile as OAuthProviderDefinition['profile'];
  const mapUser = d.mapUser as OAuthProviderDefinition['mapUser'];
  return Object.freeze({
    label: d.label as string,
    endpoints,
    scopes: Object.freeze(scopes as readonly string[]),
    ...(d.scopeSeparator === undefined ? {} : { scopeSeparator: d.scopeSeparator as string }),
    ...(d.pkce === undefined ? {} : { pkce: d.pkce as boolean }),
    ...(d.nonce === undefined ? {} : { nonce: d.nonce as boolean }),
    ...(d.clientAuth === undefined ? {} : { clientAuth: d.clientAuth as 'client_secret_post' | 'client_secret_basic' }),
    ...(authorizeParams === undefined ? {} : { authorizeParams }),
    ...(allowAddresses === undefined ? {} : { allowAddresses: Object.freeze(allowAddresses as readonly string[]) }),
    // Called as methods of the definition they came from, as a definition written with `this` expects.
    profile: (input: Parameters<typeof profile>[0]) => profile.call(definition, input),
    mapUser: (raw: unknown) => mapUser.call(definition, raw),
    // The readers `oidc()` sets (the symbols are not exported; see oidc-marker.ts): carried over as they are. They prove nothing by being there, only by what the reader answers.
    ...(typeof (definition as Partial<OidcDefinition>)[OIDC] === 'function' ? { [OIDC]: (definition as OidcDefinition)[OIDC] } : {}),
    ...((definition as Partial<OidcDefinition>)[ISSUER_PARAM] === true ? { [ISSUER_PARAM]: true as const } : {}),
  });
}

interface Registered {
  readonly name: string;
  readonly provider: ServiceProviderClass;
  readonly factory: OAuthProviderFactory;
}

/** Every provider class once, with the name each brings; `collectDrivers` already refused bad names and duplicates. */
function registered(providers: readonly ServiceProviderClass[], factories: ReadonlyMap<string, OAuthProviderFactory>): Registered[] {
  const owners = new Map<string, ServiceProviderClass>();
  for (const provider of new Set(providers)) {
    const record = provider.oauthProviders;
    if (record === undefined) continue;
    for (const name of Object.keys(record)) owners.set(name, provider);
  }
  return [...factories].map(([name, factory]) => ({ name, factory, provider: owners.get(name)! }));
}

/**
 * One variable, one config: two different credentials configs that declare a variable would both read it. The same object listed
 * by two providers is one config and fine; a class that lists a name twice is not.
 */
function checkVariables(providers: readonly ServiceProviderClass[]): void {
  const readBy = new Map<string, { config: unknown; provider: string; name: string }>();
  for (const provider of new Set(providers)) {
    const listed = new Set<string>();
    for (const config of provider.config ?? []) {
      const tag = credentialsOf(config);
      if (tag === undefined) continue;
      if (listed.has(tag.name)) refuse(`${provider.name} lists oauthCredentials("${tag.name}") twice; list it once.`);
      listed.add(tag.name);
      for (const variable of tag.variables) {
        const first = readBy.get(variable);
        if (first !== undefined && first.config !== config) {
          refuse(`${first.provider} (oauthCredentials("${first.name}")) and ${provider.name} (oauthCredentials("${tag.name}")) both read ${variable}. One variable, one provider: rename a provider or an option key.`);
        }
        readBy.set(variable, { config, provider: provider.name, name: tag.name });
      }
    }
  }
}

/** The credentials config the provider that brings `name` lists for it; A11 with the line to add when it lists none. */
function credentialsFor({ name, provider }: Registered): { readonly config: OAuthCredentialsConfig; readonly issuer: 'required' | 'optional' | undefined } {
  const own = (provider.config ?? []).filter((config) => credentialsOf(config)?.name === name);
  if (own.length === 0) {
    return refuse(
      `${provider.name} brings the OAuth provider "${name}" but lists no oauthCredentials("${name}") in its static config, so its variables are not read. ` +
        `Add it: static config = [oauthCredentials('${name}')];`,
    );
  }
  return { config: own[0] as OAuthCredentialsConfig, issuer: credentialsOf(own[0])!.issuer };
}

/**
 * Builds the registry at the start: names are checked first, then the variables of every provider, then the definition and the
 * settings of each provider that is active. A refusal throws {@link OAuthSetupError} (A11), so the app does not start.
 */
export function buildProviders(container: Container): OAuthProviders {
  const providers = container.make(Application).providers;
  let factories: ReadonlyMap<string, OAuthProviderFactory>;
  try {
    factories = collectDrivers<OAuthProviderFactory>(providers, 'oauthProviders', [], 'social login provider');
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error), error);
  }
  const entries = registered(providers, factories);
  for (const { name, provider } of entries) {
    if (name.length > MAX_NAME_LENGTH) refuse(`${provider.name} brings the OAuth provider "${name}", but a name is at most ${MAX_NAME_LENGTH} characters.`);
  }
  checkVariables(providers);
  // Positive: plain http to a loopback host is for development and test only; a missing NODE_ENV is production.
  const node = container.make(EnvironmentConfig).node;
  const local = node === 'development' || node === 'test';
  const { appUrl } = container.make(OAuthConfig);
  const active: ResolvedOAuthProvider[] = [];
  for (const entry of entries) {
    const { config, issuer: issuerRule } = credentialsFor(entry);
    const credentials = container.make(config);
    const { clientId, clientSecret, issuer } = credentials;
    if (!clientId || !clientSecret || (issuerRule === 'required' && !issuer)) continue;
    if (!container.has(HttpClient)) {
      refuse(`The OAuth provider "${entry.name}" is active, but no HttpClient is bound: register FetchServiceProvider from @marmeon/fetch (a new app has it).`);
    }
    // The callback address comes from configuration only, never from the request's host: an override, else APP_URL.
    const variables = variablePrefix(entry.name);
    if (credentials.redirectUrl !== undefined) checkEndpoint(credentials.redirectUrl, `${variables}REDIRECT_URL`, 'A11', local);
    else if (appUrl === undefined) refuse(`The OAuth provider "${entry.name}" is active but has no callback address: set APP_URL, or ${variables}REDIRECT_URL for this provider.`);
    else checkEndpoint(appUrl, `APP_URL (needed by the OAuth provider "${entry.name}")`, 'A11', local);
    if (credentials.scopes !== undefined && !credentials.scopes.every(isScope)) refuse(`${variables}SCOPES must list scopes without spaces, separated by commas.`);
    // What is checked is what is kept, and what the factory is given.
    const resolved: ResolvedOAuthProvider['credentials'] = Object.freeze({ ...credentials, clientId, clientSecret, scopes: credentials.scopes && Object.freeze([...credentials.scopes]) });
    const definition = checkDefinition(entry.name, entry.factory({ name: entry.name, credentials: resolved, container }), local);
    if (definition.allowAddresses !== undefined) {
      const http = container.make(HttpClient);
      try {
        http.allowing(definition.allowAddresses);
      } catch (error) {
        refuse(`The OAuth provider "${entry.name}": allowAddresses must be address ranges such as 10.20.0.0/16. ${error instanceof Error ? error.message : String(error)}`, error);
      }
    }
    active.push(Object.freeze({ name: entry.name, label: definition.label, definition, credentials: resolved }));
  }
  return new OAuthProviders(active);
}

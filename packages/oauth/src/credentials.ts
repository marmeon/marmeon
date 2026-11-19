import { defineConfig, env, type ConfigDefinition } from '@marmeon/core';

/** What a provider's variables hold. A missing or empty variable is `undefined`; reading never fails. */
export interface OAuthCredentials {
  readonly clientId: string | undefined;
  readonly clientSecret: string | undefined;
  /** `OAUTH_<NAME>_REDIRECT_URL`: the callback address of this provider. Without it, an active provider needs `APP_URL`. */
  readonly redirectUrl: string | undefined;
  /** `OAUTH_<NAME>_SCOPES` split at commas: the scopes the app configured, each without spaces. `undefined` when none are set. */
  readonly scopes: readonly string[] | undefined;
  /** Only read when {@link OAuthCredentialsOptions.issuer} is set. */
  readonly issuer: string | undefined;
  /** The extra variables the provider asked for, by the key it gave. */
  readonly options: Readonly<Record<string, string | undefined>>;
}

/** What a provider's variables beyond the standard ones are. See docs/oauth.md#your-own-provider. */
export interface OAuthCredentialsOptions {
  /** Reads `OAUTH_<NAME>_ISSUER`. With `'required'`, a provider without an issuer is inactive. */
  readonly issuer?: 'required' | 'optional';
  /** Extra variables, as `OAUTH_<NAME>_<KEY>`: upper case letters, digits and underscores, starting with a letter. */
  readonly options?: readonly string[];
}

/** The configuration of one provider's variables. A provider that brings a name lists exactly one in its `static config`. */
export interface OAuthCredentialsConfig extends ConfigDefinition<OAuthCredentials> {}

/** The name and the issuer rule a credentials config was made for; read back by the registry, never by name. */
interface CredentialsTag {
  readonly name: string;
  /** Every variable the config reads, whole names. */
  readonly variables: readonly string[];
  readonly issuer: 'required' | 'optional' | undefined;
}

const TAG = Symbol('marmeon.oauth.credentials');
const NAME = /^[a-z][a-z0-9-]*$/;
const OPTION_KEY = /^[A-Z][A-Z0-9_]*$/;
const STANDARD = ['CLIENT_ID', 'CLIENT_SECRET', 'REDIRECT_URL', 'SCOPES', 'ISSUER'];
/** The longest provider name. */
export const MAX_NAME_LENGTH = 32;

/** The variable prefix of a provider name: `OAUTH_` and the name in upper case, a dash becoming an underscore. */
export const variablePrefix = (name: string): string => `OAUTH_${name.replaceAll('-', '_').toUpperCase()}_`;

/**
 * The variables of the provider `name`: `OAUTH_<NAME>_CLIENT_ID`, `_CLIENT_SECRET`, `_REDIRECT_URL`, `_SCOPES` (comma-separated),
 * and `_ISSUER` and the `options` when asked. A provider that brings a name lists this in its `static config`. Throws a
 * `TypeError` for a name that is not lower case letters, digits and dashes (starting with a letter, at most 32), or an option
 * key that is malformed, repeated or one of the standard names. See docs/oauth.md#configuring-a-provider.
 */
export function oauthCredentials(name: string, options: OAuthCredentialsOptions = {}): OAuthCredentialsConfig {
  if (!NAME.test(name) || name.length > MAX_NAME_LENGTH) {
    throw new TypeError(`oauthCredentials("${name}"): a provider name is lower case letters, digits and dashes, starting with a letter, at most ${MAX_NAME_LENGTH} characters.`);
  }
  if (typeof options !== 'object' || options === null) throw new TypeError(`oauthCredentials("${name}"): the second argument is an object: { issuer, options }.`);
  for (const key of Object.keys(options)) {
    if (key !== 'issuer' && key !== 'options') throw new TypeError(`oauthCredentials("${name}"): "${key}" is not an option. The options are issuer and options.`);
  }
  if (options.issuer !== undefined && options.issuer !== 'required' && options.issuer !== 'optional') {
    throw new TypeError(`oauthCredentials("${name}"): issuer is 'required' or 'optional', not ${JSON.stringify(options.issuer)}.`);
  }
  if (options.options !== undefined && !Array.isArray(options.options)) throw new TypeError(`oauthCredentials("${name}"): options is a list of keys.`);
  const keys = options.options ?? [];
  for (const [index, key] of keys.entries()) {
    if (typeof key !== 'string' || !OPTION_KEY.test(key)) {
      throw new TypeError(`oauthCredentials("${name}"): the option key "${String(key)}" must be upper case letters, digits and underscores, starting with a letter.`);
    }
    if (STANDARD.includes(key)) throw new TypeError(`oauthCredentials("${name}"): the option key "${key}" is a variable every provider has. Choose another key.`);
    if (keys.indexOf(key) !== index) throw new TypeError(`oauthCredentials("${name}"): the option key "${key}" is listed twice.`);
  }
  const prefix = variablePrefix(name);
  const names = {
    clientId: `${prefix}CLIENT_ID`,
    clientSecret: `${prefix}CLIENT_SECRET`,
    redirectUrl: `${prefix}REDIRECT_URL`,
    scopes: `${prefix}SCOPES`,
    issuer: options.issuer === undefined ? undefined : `${prefix}ISSUER`,
  };
  const optional = env.string().optional();
  const listed = [names.clientId, names.clientSecret, names.redirectUrl, names.scopes, ...(names.issuer ? [names.issuer] : []), ...keys.map((key) => `${prefix}${key}`)];
  const variables: Record<string, typeof optional> = {};
  for (const variable of listed) variables[variable] = optional;
  const base = defineConfig(`oauth:${name}`, {
    env: env(variables),
    resolve: (e: Readonly<Record<string, string | undefined>>): OAuthCredentials => {
      const scopes = e[names.scopes]
        ?.split(',')
        .map((scope) => scope.trim())
        .filter((scope) => scope !== '');
      return {
        clientId: e[names.clientId],
        clientSecret: e[names.clientSecret],
        redirectUrl: e[names.redirectUrl],
        scopes: scopes && scopes.length > 0 ? scopes : undefined,
        issuer: names.issuer === undefined ? undefined : e[names.issuer],
        options: Object.freeze(Object.fromEntries(keys.map((key) => [key, e[`${prefix}${key}`]]))),
      };
    },
  });
  const tag: CredentialsTag = { name, variables: Object.freeze(listed), issuer: options.issuer };
  return Object.freeze({ ...base, [TAG]: tag }) as OAuthCredentialsConfig;
}

/** What `config` was made for, or `undefined` when it is not a credentials config. Looked up by the private symbol, never by name. */
export function credentialsOf(config: unknown): CredentialsTag | undefined {
  return typeof config === 'object' && config !== null ? (config as { [TAG]?: CredentialsTag })[TAG] : undefined;
}

import { createApplication, type ServiceProviderClass } from '@marmeon/core';
import { FetchServiceProvider } from '@marmeon/fetch';
import { describe, expect, it, vi } from 'vitest';
import { oauthCredentials } from './credentials.ts';
import { OAuthSetupError } from './config.ts';
import { defineOAuthProvider, type OAuthProviderDefinition, type OAuthProviderFactory } from './definition.ts';
import { OAuthServiceProvider } from './provider.ts';
import { OAuthProviders } from './registry.ts';
import { activeEnv, definition, oauthApp, providerBringing } from './test-helpers/app.ts';
import { expectA11, failure } from './test-helpers/start.ts';

type Overrides = Partial<OAuthProviderDefinition>;
const factory = (overrides: Overrides = {}) => defineOAuthProvider(definition(overrides));
const providersOf = (app: Awaited<ReturnType<typeof oauthApp>>) => app.application.container.make(OAuthProviders);

describe('OAuthServiceProvider: names', () => {
  it('stops the start when two providers bring one name, naming both', async () => {
    const error = await failure(oauthApp([providerBringing('FirstProvider', { idp: factory() }), providerBringing('SecondProvider', { idp: factory() })]));
    expect(expectA11(error)).toMatch(/social login provider "idp" is brought by both FirstProvider and SecondProvider/);
    expect((error as Error).cause).toBeInstanceOf(TypeError);
  });

  it('stops the start (A11) for a name with capitals, and for a value that is not a function', async () => {
    expect(expectA11(await failure(oauthApp([providerBringing('Mine', { Gitea: factory() }, [])])))).toMatch(/"Gitea".*lowercase letters, digits and dashes/);
    class NotAFunction {
      static config = [oauthCredentials('idp')];
      static oauthProviders = { idp: 1 } as never;
    }
    expect(expectA11(await failure(oauthApp([NotAFunction])))).toMatch(/NotAFunction\.oauthProviders\.idp must be a function/);
  });

  it('stops the start (A11) for an oauthProviders that is no object', async () => {
    class Listed {
      static config = [oauthCredentials('idp')];
      static oauthProviders = [factory()] as never;
    }
    expect(expectA11(await failure(oauthApp([Listed])))).toMatch(/Listed\.oauthProviders must be an object/);
    class Texted {
      static config = [oauthCredentials('idp')];
      static oauthProviders = 'idp' as never;
    }
    expect(expectA11(await failure(oauthApp([Texted])))).toMatch(/Texted\.oauthProviders must be an object/);
  });

  it('stops the start (A11) when the registering provider lists no oauthCredentials for the name, quoting the line to add', async () => {
    class Bare {
      static config = [oauthCredentials('other')];
      static oauthProviders = { keycloak: factory() };
    }
    expect(expectA11(await failure(oauthApp([Bare])))).toContain("Add it: static config = [oauthCredentials('keycloak')];");
    // Credentials another class lists for the name do not satisfy it: the class that brings the name lists its own.
    class Lists {
      static config = [oauthCredentials('keycloak')];
    }
    expect(expectA11(await failure(oauthApp([providerBringing('Mine', { keycloak: factory() }, []), Lists])))).toContain("oauthCredentials('keycloak')");
  });

  it('stops the start (A11) for a name over 32 characters', async () => {
    expect(expectA11(await failure(oauthApp([providerBringing('Long', { ['a'.repeat(33)]: factory() }, [])])))).toMatch(/at most 32 characters/);
  });

  it('stops the start when two credential configs read one variable, a standard one or an option key', async () => {
    class First {
      static config = [oauthCredentials('idp')];
      static oauthProviders = { idp: factory() };
    }
    class Second {
      static config = [oauthCredentials('idp')];
    }
    expect(expectA11(await failure(oauthApp([First, Second])))).toMatch(/First \(oauthCredentials\("idp"\)\) and Second \(oauthCredentials\("idp"\)\) both read OAUTH_IDP_CLIENT_ID/);
    // The prefixes differ, the variables do not: OAUTH_A_CLIENT_ID is `a`'s id and `a-client`'s option ID.
    class A {
      static config = [oauthCredentials('a')];
      static oauthProviders = { a: factory() };
    }
    class AClient {
      static config = [oauthCredentials('a-client', { options: ['ID', 'SECRET'] })];
      static oauthProviders = { 'a-client': factory() };
    }
    expect(expectA11(await failure(oauthApp([A, AClient])))).toMatch(/both read OAUTH_A_CLIENT_ID/);
    class My {
      static config = [oauthCredentials('my')];
      static oauthProviders = { my: factory() };
    }
    class MyIdp {
      static config = [oauthCredentials('my-idp')];
      static oauthProviders = { 'my-idp': factory() };
    }
    class AnotherMy {
      static config = [oauthCredentials('my', { options: ['IDP_CLIENT_ID'] })];
      static oauthProviders = { my: factory() };
    }
    // Names that differ only in the dash read different variables.
    await oauthApp([My, MyIdp]);
    expect(expectA11(await failure(oauthApp([MyIdp, AnotherMy])))).toMatch(/both read OAUTH_MY_IDP_CLIENT_ID/);
  });

  it('stops the start when a class lists oauthCredentials for one name twice, as two objects or as one', async () => {
    class Two {
      static config = [oauthCredentials('idp'), oauthCredentials('idp')];
      static oauthProviders = { idp: factory() };
    }
    expect(expectA11(await failure(oauthApp([Two])))).toBe('[marmeon:A11] Two lists oauthCredentials("idp") twice; list it once.');
    const same = oauthCredentials('idp');
    class One {
      static config = [same, same];
      static oauthProviders = { idp: factory() };
    }
    expect(expectA11(await failure(oauthApp([One])))).toContain('One lists oauthCredentials("idp") twice');
  });

  it('accepts one credentials object that two classes list', async () => {
    const shared = oauthCredentials('idp');
    class Brings {
      static config = [shared];
      static oauthProviders = { idp: factory({ label: 'Shared' }) };
    }
    class Lists {
      static config = [shared];
    }
    const app = await oauthApp([Brings, Lists], activeEnv('idp'));
    expect(providersOf(app).get('idp')?.label).toBe('Shared');
  });
});

describe('OAuthServiceProvider: active providers', () => {
  it('treats a provider without client id or secret as inactive and never calls its factory', async () => {
    const create = vi.fn(factory());
    const bring = providerBringing('Idp', { idp: create });
    for (const env of [{}, { OAUTH_IDP_CLIENT_ID: 'id' }, { OAUTH_IDP_CLIENT_SECRET: 'secret' }, { OAUTH_IDP_CLIENT_ID: '', OAUTH_IDP_CLIENT_SECRET: 'secret' }]) {
      expect(providersOf(await oauthApp([bring], env)).get('idp')).toBeUndefined();
    }
    expect(create).not.toHaveBeenCalled();
  });

  it('treats an issuer-required provider without issuer as inactive', async () => {
    class Idp {
      static config = [oauthCredentials('idp', { issuer: 'required' })];
      static oauthProviders = { idp: factory() };
    }
    expect(providersOf(await oauthApp([Idp], activeEnv('idp'))).get('idp')).toBeUndefined();
    const withIssuer = await oauthApp([Idp], { ...activeEnv('idp'), OAUTH_IDP_ISSUER: 'https://id.example.com' });
    expect(providersOf(withIssuer).get('idp')?.credentials.issuer).toBe('https://id.example.com');
  });

  it('hands the factory its name, credentials and container', async () => {
    let seen: Parameters<OAuthProviderFactory>[0] | undefined;
    const bring = providerBringing('Idp', { idp: defineOAuthProvider((context) => ((seen = context), definition())) });
    const app = await oauthApp([bring], { ...activeEnv('idp'), OAUTH_IDP_SCOPES: 'a,b' });
    expect(seen).toMatchObject({ name: 'idp', credentials: { clientId: 'client', clientSecret: 'secret', scopes: ['a', 'b'] } });
    expect(seen?.container).toBe(app.application.container);
  });

  it('get() answers only active providers; active() lists name and label', async () => {
    const bring = providerBringing('Two', { alpha: factory({ label: 'Alpha' }), beta: factory({ label: 'Beta' }), gamma: factory({ label: 'Gamma' }) });
    const providers = providersOf(await oauthApp([bring], { ...activeEnv('alpha'), ...activeEnv('gamma') }));
    expect(providers.get('alpha')?.label).toBe('Alpha');
    expect(providers.get('alpha')?.credentials).toMatchObject({ clientId: 'client', clientSecret: 'secret' });
    expect(providers.get('beta')).toBeUndefined();
    expect(providers.get('unknown')).toBeUndefined();
    expect(providers.active()).toEqual([{ name: 'alpha', label: 'Alpha' }, { name: 'gamma', label: 'Gamma' }]);
  });

  it('stops the start when a provider is active but no HttpClient is bound', async () => {
    const bring = providerBringing('Idp', { idp: factory() });
    const start = (providers: ServiceProviderClass[], env: Record<string, string>) =>
      createApplication({ root: import.meta.dirname, discover: false, providers }, { env: { LOG_LEVEL: 'silent', ...env } });
    expect(expectA11(await failure(start([OAuthServiceProvider, bring], activeEnv('idp'))))).toMatch(/"idp" is active, but no HttpClient is bound/);
    // Inactive, no client is needed; bound, it starts.
    await start([OAuthServiceProvider, bring], {});
    await start([FetchServiceProvider, OAuthServiceProvider, bring], activeEnv('idp'));
  });
});

describe('OAuthServiceProvider: the settings of an active provider', () => {
  const bring = providerBringing('Idp', { idp: factory() });
  const start = (env: Record<string, string | undefined>) => failure(oauthApp([bring], { ...activeEnv('idp'), ...env }));

  it('refuses an APP_URL and a redirect override that are no https address, a loopback http one only in test and development', async () => {
    expect(await start({ APP_URL: 'https://app.example.com/base' })).toBeUndefined();
    expect(await start({ APP_URL: 'http://localhost:3000' })).toBeUndefined();
    expect(expectA11(await start({ APP_URL: 'http://localhost:3000', NODE_ENV: 'production' }))).toMatch(/APP_URL .*is not a usable endpoint/);
    for (const APP_URL of ['http://app.example.com', 'app.example.com', 'https://user:pw@app.example.com', 'https://app.example.com/#x']) {
      expect(expectA11(await start({ APP_URL })), APP_URL).toMatch(/APP_URL .*is not a usable endpoint/);
    }
    expect(await start({ OAUTH_IDP_REDIRECT_URL: 'https://app.example.com/auth/idp/callback' })).toBeUndefined();
    for (const OAUTH_IDP_REDIRECT_URL of ['/auth/idp/callback', 'http://app.example.com/cb', 'https://app.example.com/cb#frag']) {
      expect(expectA11(await start({ OAUTH_IDP_REDIRECT_URL })), OAUTH_IDP_REDIRECT_URL).toMatch(/OAUTH_IDP_REDIRECT_URL is not a usable endpoint/);
    }
  });

  it('needs APP_URL only for an active provider without its own redirect address, and names that provider', async () => {
    // Inactive: nothing is checked. With an override of its own: APP_URL is not needed, nor looked at.
    expect(await failure(oauthApp([bring], { APP_URL: 'not a url' }))).toBeUndefined();
    const own = { OAUTH_IDP_CLIENT_ID: 'id', OAUTH_IDP_CLIENT_SECRET: 's', OAUTH_IDP_REDIRECT_URL: 'https://app.example.com/cb' };
    expect(await failure(oauthApp([bring], own))).toBeUndefined();
    expect(await failure(oauthApp([bring], { ...own, APP_URL: 'not a url' }))).toBeUndefined();
    // Active without either: the request's host is never a fallback.
    const none = { OAUTH_IDP_CLIENT_ID: 'id', OAUTH_IDP_CLIENT_SECRET: 's' };
    expect(expectA11(await failure(oauthApp([bring], none)))).toMatch(/OAuth provider "idp" is active but has no callback address: set APP_URL, or OAUTH_IDP_REDIRECT_URL/);
    expect(expectA11(await failure(oauthApp([bring], { ...none, APP_URL: 'not a url' })))).toMatch(/APP_URL \(needed by the OAuth provider "idp"\) is not a usable endpoint/);
  });

  it('refuses scopes from OAUTH_<NAME>_SCOPES that hold a space', async () => {
    expect(await start({ OAUTH_IDP_SCOPES: 'openid, email' })).toBeUndefined();
    expect(expectA11(await start({ OAUTH_IDP_SCOPES: 'openid email,profile' }))).toMatch(/OAUTH_IDP_SCOPES must list at most 64 scopes without spaces/);
    expect(await start({ OAUTH_IDP_SCOPES: Array.from({ length: 64 }, (_, i) => `${i}`.padEnd(255, 'x')).join(',') })).toBeUndefined();
    expect(expectA11(await start({ OAUTH_IDP_SCOPES: Array.from({ length: 65 }, (_, i) => `s${i}`).join(',') }))).toMatch(/OAUTH_IDP_SCOPES must list at most 64/);
    expect(expectA11(await start({ OAUTH_IDP_SCOPES: 'x'.repeat(256) }))).toMatch(/255 characters/);
  });

  it('refuses an allowAddresses entry that is no address range, and accepts a range', async () => {
    const run = (allowAddresses: string[]) => failure(oauthApp([providerBringing('Idp', { idp: factory({ allowAddresses }) })], activeEnv('idp')));
    expect(await run(['10.20.0.0/16', 'fd00::/8'])).toBeUndefined();
    expect(expectA11(await run(['gitea.internal']))).toMatch(/allowAddresses must be address ranges/);
    const error = expectA11(await run(['10.0.0.0/8', '']));
    expect(error).toMatch(/allowAddresses/);
    expect((await run(['gitea.internal'])) as Error).toHaveProperty('cause');
  });

  it('lets a failure of the HttpClient itself through, not as an allowAddresses problem', async () => {
    const bringing = providerBringing('Idp', { idp: factory({ allowAddresses: ['10.0.0.0/8'] }) });
    // OAuthServiceProvider boots first here, so it is the one that builds the client, which FETCH_DRIVER makes fail.
    const error = await failure(
      createApplication(
        { root: import.meta.dirname, discover: false, providers: [OAuthServiceProvider, bringing, FetchServiceProvider] },
        { env: { LOG_LEVEL: 'silent', FETCH_DRIVER: 'nobody-brought-this', ...activeEnv('idp') } },
      ),
    );
    expect(error).not.toBeInstanceOf(OAuthSetupError);
    expect(String(error)).toContain('[marmeon:S9]');
  });
});

describe('OAuthServiceProvider: definitions', () => {
  const start = (overrides: Overrides, env: Record<string, string | undefined> = {}) =>
    failure(oauthApp([providerBringing('Idp', { idp: factory(overrides) })], { ...activeEnv('idp'), ...env }));

  it('refuses an http endpoint outside development, and one on a non-loopback host in development', async () => {
    const http = { authorizeUrl: 'http://localhost:9000/authorize', tokenUrl: 'http://localhost:9000/token' };
    expect(await start({ endpoints: http })).toBeUndefined();
    expect(await start({ endpoints: { ...http, authorizeUrl: 'http://[::1]:9000/a', tokenUrl: 'http://127.0.0.1:9000/t' } }, { NODE_ENV: 'development' })).toBeUndefined();
    expect(expectA11(await start({ endpoints: http }, { NODE_ENV: 'production' }))).toMatch(/authorizeUrl is not a usable endpoint: it must use https/);
    // A NODE_ENV that is none of the three stops the start before any provider is looked at; http never gets through it.
    for (const NODE_ENV of ['staging', 'prodution']) {
      const error = await start({ endpoints: http }, { NODE_ENV });
      expect(String(error), NODE_ENV).toContain('[marmeon:K6]');
    }
    expect(expectA11(await start({ endpoints: http }, { NODE_ENV: '' }))).toMatch(/authorizeUrl is not a usable endpoint: it must use https/);
    expect(expectA11(await start({ endpoints: { ...http, tokenUrl: 'http://id.example.com/token' } }, { NODE_ENV: 'development' }))).toMatch(/tokenUrl is not a usable endpoint: http is accepted only for localhost/);
    expect(expectA11(await start({ endpoints: { ...http, tokenUrl: 'http://localhost.example.com/token' } }))).toMatch(/tokenUrl.*http is accepted only for localhost/);
    for (const bad of ['https://user:pw@id.example.com/t', 'https://:pw@id.example.com/t', 'https://id.example.com/t#frag', 'https://id.example.com/t#', '/token', 'ftp://id.example.com/t', 'javascript:alert(1)']) {
      expect(expectA11(await start({ endpoints: { authorizeUrl: 'https://id.example.com/a', tokenUrl: bad } })), bad).toMatch(/tokenUrl is not a usable endpoint/);
    }
    expect(expectA11(await start({ endpoints: { authorizeUrl: 'https://id.example.com/a', tokenUrl: 'https://id.example.com/t', issuer: 'http://id.example.com' } }))).toMatch(/issuer is not a usable endpoint/);
  });

  it('accepts a function that finds the endpoints', async () => {
    expect(await start({ endpoints: async () => ({ authorizeUrl: 'https://id.example.com/a', tokenUrl: 'https://id.example.com/t' }) })).toBeUndefined();
  });

  it('refuses authorizeParams that set state, redirect_uri, prompt, max_age or another reserved parameter', async () => {
    const reserved = ['response_type', 'response_mode', 'client_id', 'redirect_uri', 'scope', 'state', 'code_challenge', 'code_challenge_method', 'nonce', 'prompt', 'max_age', 'request', 'request_uri'];
    for (const key of [...reserved, 'State', 'REDIRECT_URI', 'Request_Uri']) {
      expect(expectA11(await start({ authorizeParams: { [key]: 'x' } })), key).toMatch(new RegExp(`authorizeParams cannot set "${key}"`));
    }
    expect(await start({ authorizeParams: { access_type: 'offline', hd: 'example.com' } })).toBeUndefined();
    expect(expectA11(await start({ authorizeParams: { access_type: 1 as unknown as string } }))).toMatch(/authorizeParams must be an object of strings/);
    expect(expectA11(await start({ authorizeParams: ['state'] as never }))).toMatch(/authorizeParams must be an object of strings/);
  });

  it('refuses an authorizeUrl whose query sets a reserved parameter', async () => {
    const withQuery = (query: string) => ({ authorizeUrl: `https://id.example.com/authorize?${query}`, tokenUrl: 'https://id.example.com/token' });
    expect(await start({ endpoints: withQuery('tenant=acme&hd=example.com') })).toBeUndefined();
    for (const key of ['state', 'redirect_uri', 'response_mode', 'request', 'STATE', 'Max_Age']) {
      expect(expectA11(await start({ endpoints: withQuery(`a=1&${key}=x`) })), key).toMatch(new RegExp(`sets "${key}" in the query of authorizeUrl`));
    }
  });

  it('refuses a field that is not part of a definition, such as a mistyped nonce or pkce', async () => {
    expect(expectA11(await start({ nonse: true } as never))).toMatch(/"nonse"/);
    expect(expectA11(await start({ pkcs: false } as never))).toMatch(/"pkcs"/);
  });

  it('refuses an empty label, a label that is no string and a scope with a space', async () => {
    expect(expectA11(await start({ label: '' }))).toMatch(/label of 1 to 64 characters/);
    expect(expectA11(await start({ label: 'x'.repeat(65) }))).toMatch(/label of 1 to 64/);
    expect(expectA11(await start({ label: 7 as never }))).toMatch(/label of 1 to 64/);
    expect(await start({ label: 'x'.repeat(64) })).toBeUndefined();
    expect(expectA11(await start({ scopes: ['read write'] }))).toMatch(/scopes/);
    expect(expectA11(await start({ scopes: ['read', ''] }))).toMatch(/scopes/);
    expect(expectA11(await start({ scopes: ['read\twrite'] }))).toMatch(/scopes/);
    // The limits of a flow: 64 scopes of 255 characters at most, so that no flow the app starts is one the callback refuses.
    expect(await start({ scopes: Array.from({ length: 64 }, (_, i) => `${i}`.padEnd(255, 'x')) })).toBeUndefined();
    expect(expectA11(await start({ scopes: Array.from({ length: 65 }, (_, i) => `s${i}`) }))).toMatch(/at most 64/);
    expect(expectA11(await start({ scopes: ['x'.repeat(256)] }))).toMatch(/255 characters/);
    // A hole is no scope.
    expect(expectA11(await start({ scopes: Object.assign([], { length: 2 }) as never }))).toMatch(/scopes/);
  });

  it('refuses a definition whose parts have the wrong type', async () => {
    const cases: [Overrides, RegExp][] = [
      [{ endpoints: undefined as never }, /needs endpoints/],
      [{ scopes: undefined as never }, /needs scopes/],
      [{ scopeSeparator: 1 as never }, /scopeSeparator/],
      [{ pkce: 'yes' as never }, /pkce/],
      [{ nonce: 1 as never }, /nonce/],
      [{ clientAuth: 'none' as never }, /clientAuth/],
      [{ allowAddresses: [1] as never }, /allowAddresses/],
      [{ profile: undefined as never }, /profile\(\)/],
      [{ mapUser: 'x' as never }, /mapUser\(\)/],
    ];
    for (const [overrides, expected] of cases) expect(expectA11(await start(overrides)), JSON.stringify(Object.keys(overrides))).toMatch(expected);
    expect(expectA11(await failure(oauthApp([providerBringing('Idp', { idp: () => undefined as never })], activeEnv('idp'))))).toMatch(/must create a definition object/);
  });

  it('checks what it reads once: a getter that answers differently the second time changes nothing', async () => {
    const reads: Record<string, number> = {};
    const once = <T>(key: string, first: T, later: T): T => (reads[key] = (reads[key] ?? 0) + 1) === 1 ? first : later;
    const tricky = {
      ...definition(),
      get label() {
        return once('label', 'Honest', '');
      },
      get scopes() {
        return once('scopes', ['read'], ['read write']);
      },
      get endpoints() {
        return {
          get authorizeUrl() {
            return once('authorize', 'https://id.example.com/authorize', 'http://evil.example.com/authorize');
          },
          tokenUrl: 'https://id.example.com/token',
        };
      },
      get authorizeParams() {
        return once<Record<string, string>>('params', { hd: 'example.com' }, { state: 'x' });
      },
    } as OAuthProviderDefinition;
    const app = await oauthApp([providerBringing('Idp', { idp: () => tricky })], activeEnv('idp'));
    const provider = providersOf(app).get('idp')!;
    expect(provider.label).toBe('Honest');
    expect(provider.definition).toMatchObject({ label: 'Honest', scopes: ['read'], endpoints: { authorizeUrl: 'https://id.example.com/authorize' }, authorizeParams: { hd: 'example.com' } });
  });

  it('keeps what it checked: changing the objects after the start changes nothing', async () => {
    const source = { ...definition({ authorizeParams: { hd: 'example.com' }, allowAddresses: ['10.0.0.0/8'] }), endpoints: { authorizeUrl: 'https://id.example.com/authorize', tokenUrl: 'https://id.example.com/token' }, scopes: ['read'] };
    const app = await oauthApp([providerBringing('Idp', { idp: () => source })], { ...activeEnv('idp'), OAUTH_IDP_SCOPES: 'a,b' });
    source.label = 'Changed';
    source.scopes.push('write');
    source.endpoints.tokenUrl = 'http://evil.example.com/token';
    (source.authorizeParams as Record<string, string>).state = 'x';
    (source.allowAddresses as string[]).push('0.0.0.0/0');
    const provider = providersOf(app).get('idp')!;
    expect(provider.definition).toMatchObject({ label: 'Example', scopes: ['read'] });
    expect(provider.definition.endpoints).toEqual({ authorizeUrl: 'https://id.example.com/authorize', tokenUrl: 'https://id.example.com/token' });
    expect(provider.definition.authorizeParams).toEqual({ hd: 'example.com' });
    expect(provider.definition.allowAddresses).toEqual(['10.0.0.0/8']);
    for (const frozen of [provider, provider.definition, provider.definition.scopes, provider.definition.endpoints, provider.credentials, provider.credentials.scopes]) expect(Object.isFrozen(frozen)).toBe(true);
  });

  it('keeps an issuer exactly as written', async () => {
    const issuer = 'https://ID.example.com/Tenant/';
    const app = await oauthApp([providerBringing('Idp', { idp: factory({ endpoints: { authorizeUrl: 'https://ID.example.com/Tenant/authorize', tokenUrl: 'https://id.example.com/token', issuer } }) })], activeEnv('idp'));
    expect(providersOf(app).get('idp')?.definition.endpoints).toEqual({ authorizeUrl: 'https://id.example.com/Tenant/authorize', tokenUrl: 'https://id.example.com/token', issuer });
  });

  it('gives the factory the credentials it will be kept with, and they cannot be changed', async () => {
    let changed: string | undefined = 'untouched';
    const create: OAuthProviderFactory = (context) => {
      try {
        (context.credentials as { redirectUrl: string | undefined }).redirectUrl = 'http://evil.example.com/cb';
        changed = 'changed';
      } catch (error) {
        changed = error instanceof TypeError ? 'refused' : 'other';
      }
      return definition();
    };
    const app = await oauthApp([providerBringing('Idp', { idp: create })], { ...activeEnv('idp'), OAUTH_IDP_REDIRECT_URL: 'https://app.example.com/cb' });
    expect(changed).toBe('refused');
    expect(providersOf(app).get('idp')?.credentials.redirectUrl).toBe('https://app.example.com/cb');
  });

  it('accepts the instance of a class whose profile() and mapUser() read its own state, and refuses a plain object with a field of its own', async () => {
    class Gitea {
      readonly #server = 'https://gitea.example.com';
      readonly region = 'eu';
      readonly label = 'Gitea';
      readonly endpoints = { authorizeUrl: 'https://gitea.example.com/authorize', tokenUrl: 'https://gitea.example.com/token' };
      readonly scopes = ['read'];
      async profile() {
        return { id: `${this.#server}/${this.region}` };
      }
      mapUser(raw: { id: string }) {
        return { id: `${raw.id}/${this.region}`, email: null, emailVerified: false, name: null, nickname: null, avatar: null };
      }
    }
    const app = await oauthApp([providerBringing('Idp', { idp: () => new Gitea() as never })], activeEnv('idp'));
    const { definition: kept } = providersOf(app).get('idp')!;
    const raw = await kept.profile({} as never);
    expect(raw).toEqual({ id: 'https://gitea.example.com/eu' });
    expect(kept.mapUser(raw).id).toBe('https://gitea.example.com/eu/eu');
    expect(expectA11(await start({ server: 'https://gitea.example.com' } as never))).toMatch(/"server"/);
  });
});

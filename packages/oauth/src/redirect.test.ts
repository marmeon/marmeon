import { errorCodeOf, type Container } from '@marmeon/core';
import { Session, SessionConfig } from '@marmeon/session';
import { describe, expect, it } from 'vitest';
import { OAuthSetupError } from './config.ts';
import { defineOAuthProvider } from './definition.ts';
import { flowKey, type OpenFlow } from './flow.ts';
import { OAuth } from './oauth.ts';
import { OAuthHttpError } from './http.ts';
import { activeEnv, definition, oauthApp, providerBringing } from './test-helpers/app.ts';
import { fakeSession, oauthWith, recordingLogger, sessionsFrom } from './test-helpers/flow.ts';

const flowOf = (session: { data: Map<string, unknown> }): OpenFlow => session.data.get(flowKey('idp')) as OpenFlow;
const rejection = (promise: Promise<unknown>): Promise<unknown> => promise.then(() => undefined, (error: unknown) => error);

describe('OAuth.redirect()', () => {
  it("builds the authorization URL with the package's state, challenge and redirect_uri, whatever authorizeParams say", async () => {
    // A definition the registry would refuse: this proves the flow itself does not let a provider's parameters win.
    const { oauth, session } = oauthWith({
      overrides: {
        authorizeParams: { state: 'forged', redirect_uri: 'https://evil.example/cb', code_challenge: 'forged', code_challenge_method: 'plain', response_type: 'token', client_id: 'other', scope: 'admin', access_type: 'offline' },
      },
    });
    const result = await oauth.redirect('idp');
    if (!result.ok) throw new Error('expected a URL');
    const params = result.value.searchParams;
    const flow = flowOf(session);
    expect(result.value.origin + result.value.pathname).toBe('https://id.example.com/authorize');
    expect(params.get('response_type')).toBe('code');
    expect(params.get('client_id')).toBe('client');
    expect(params.get('redirect_uri')).toBe('https://app.example.com/auth/idp/callback');
    expect(params.get('scope')).toBe('profile');
    expect(params.get('state')).toBe(flow.state);
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('code_challenge')).not.toBe('forged');
    expect(params.getAll('state')).toHaveLength(1);
    // What a provider adds besides is kept.
    expect(params.get('access_type')).toBe('offline');
  });

  it('keeps the query of the authorizeUrl and sends no PKCE challenge for a provider without PKCE', async () => {
    const { oauth } = oauthWith({ overrides: { pkce: false, endpoints: { authorizeUrl: 'https://id.example.com/authorize?tenant=a', tokenUrl: 'https://id.example.com/token' } } });
    const result = await oauth.redirect('idp');
    if (!result.ok) throw new Error('expected a URL');
    expect(result.value.searchParams.get('tenant')).toBe('a');
    expect(result.value.searchParams.has('code_challenge')).toBe(false);
    expect(result.value.searchParams.has('code_challenge_method')).toBe(false);
  });

  it('takes the redirect_uri from APP_URL and the fixed callback path, whatever the form of APP_URL', async () => {
    for (const [appUrl, expected] of [
      ['https://app.example.com', 'https://app.example.com/auth/idp/callback'],
      ['https://app.example.com/', 'https://app.example.com/auth/idp/callback'],
      ['https://app.example.com/base/', 'https://app.example.com/base/auth/idp/callback'],
      ['https://app.example.com/?x=1', 'https://app.example.com/auth/idp/callback'],
      ['https://app.example.com/base//', 'https://app.example.com/base/auth/idp/callback'],
    ] as const) {
      const { oauth } = oauthWith({ appUrl });
      const result = await oauth.redirect('idp');
      expect(result.ok && result.value.searchParams.get('redirect_uri'), appUrl).toBe(expected);
    }
  });

  it('prefers OAUTH_<N>_REDIRECT_URL', async () => {
    const { oauth } = oauthWith({ redirectUrl: 'https://login.example.com/back' });
    const result = await oauth.redirect('idp');
    expect(result.ok && result.value.searchParams.get('redirect_uri')).toBe('https://login.example.com/back');
  });

  it('throws A10 for SESSION_SAME_SITE=strict, before any flow is stored', async () => {
    const { oauth, session } = oauthWith({ sameSite: 'strict' });
    const error = await rejection(oauth.redirect('idp'));
    expect(errorCodeOf(error)).toBe('A10');
    expect((error as Error).message).toMatch(/SESSION_SAME_SITE=strict.*cross-site/);
    expect(session.data.size).toBe(0);
    for (const sameSite of ['lax', 'none']) expect((await oauthWith({ sameSite }).oauth.redirect('idp')).ok, sameSite).toBe(true);
  });

  it('throws A10 for a session that is not started or that this request may not write, and stores nothing', async () => {
    for (const state of [{ started: false }, { readOnly: true }]) {
      const session = fakeSession(state);
      const { oauth, http } = oauthWith({ session });
      const error = await rejection(oauth.redirect('idp'));
      expect(errorCodeOf(error), JSON.stringify(state)).toBe('A10');
      expect(session.data.size).toBe(0);
      http.assertNothingSent();
    }
  });

  it('throws A10 without APP_URL and without a redirect URL', async () => {
    const { oauth, session } = oauthWith({ appUrl: undefined });
    const error = await rejection(oauth.redirect('idp'));
    expect(errorCodeOf(error)).toBe('A10');
    expect((error as Error).message).toMatch(/APP_URL.*OAUTH_IDP_REDIRECT_URL/);
    expect(session.data.size).toBe(0);
  });

  it('throws A10 for a callback address that is no usable endpoint', async () => {
    for (const parts of [{ appUrl: 'http://app.example.com' }, { redirectUrl: 'https://u:p@app.example.com/cb' }]) {
      const { oauth, session } = oauthWith(parts);
      const error = await rejection(oauth.redirect('idp'));
      expect(error).toBeInstanceOf(OAuthSetupError);
      expect(errorCodeOf(error)).toBe('A10');
      expect(session.data.size).toBe(0);
    }
  });

  it('answers unknown-provider for an unknown or inactive name and leaves the session untouched', async () => {
    const session = fakeSession({ started: false });
    const { oauth, http } = oauthWith({ session });
    for (const name of ['nobody', '', 'IDP', '__proto__', 'constructor']) {
      expect(await oauth.redirect(name), name).toEqual({ ok: false, error: { kind: 'unknown-provider' } });
    }
    expect(session.data.size).toBe(0);
    http.assertNothingSent();
    // A provider whose variables are not set is not active, so it is unknown too.
    const own = fakeSession();
    const app = await oauthApp([providerBringing('Mine', { idp: defineOAuthProvider(definition()) }), sessionsFrom([own])]);
    const scope = app.application.container.createScope();
    expect(await scope.make(OAuth).redirect('idp')).toEqual({ ok: false, error: { kind: 'unknown-provider' } });
    expect(own.data.size).toBe(0);
  });

  it('answers unavailable when discovering the endpoints fails, and stores no flow', async () => {
    const discover = (failure: 'status' | 'network') =>
      oauthWith({
        overrides: {
          endpoints: async (http) => {
            if (failure === 'network') throw new OAuthHttpError(0);
            return (await http.json('https://id.example.com/.well-known/openid-configuration')) as never;
          },
        },
      });
    const down = discover('status');
    down.http.respond('https://id.example.com/.well-known/openid-configuration', new Response('upstream', { status: 503 }));
    expect(await down.oauth.redirect('idp')).toEqual({ ok: false, error: { kind: 'unavailable' } });
    expect(down.session.data.size).toBe(0);
    const offline = discover('network');
    expect(await offline.oauth.redirect('idp')).toEqual({ ok: false, error: { kind: 'unavailable' } });
    expect(offline.session.data.size).toBe(0);
  });

  it('uses discovered endpoints, answers unavailable for a document that fails the start\'s check, and lets a bug of the provider through', async () => {
    const found = (document: unknown, logger = recordingLogger()) => ({ ...oauthWith({ logger, overrides: { endpoints: async () => document as never } }), logger });
    const good = found({ authorizeUrl: 'https://id2.example.com/authorize', tokenUrl: 'https://id2.example.com/token' });
    const result = await good.oauth.redirect('idp');
    expect(result.ok && result.value.origin).toBe('https://id2.example.com');
    for (const [document, reason] of [
      [{ authorizeUrl: 'http://id2.example.com/authorize', tokenUrl: 'https://id2.example.com/token' }, 'authorizeUrl: it must use https (http is accepted for a loopback host only while developing or testing).'],
      [{ authorizeUrl: 'https://id2.example.com/authorize?state=SECRET-KEY', tokenUrl: 'https://id2.example.com/token' }, 'authorizeUrl: its query sets a parameter that the flow sets itself.'],
      [{ authorizeUrl: 'https://id2.example.com/authorize?SECRET-KEY=1&Scope=x', tokenUrl: 'https://id2.example.com/token' }, 'authorizeUrl: its query sets a parameter that the flow sets itself.'],
      [{ authorizeUrl: 'https://id2.example.com/authorize' }, 'tokenUrl: it must be a string.'],
      [null, 'endpoints: it must be an object with authorizeUrl and tokenUrl.'],
    ] as const) {
      const bad = found(document);
      expect(await bad.oauth.redirect('idp'), JSON.stringify(document)).toEqual({ ok: false, error: { kind: 'unavailable' } });
      expect(bad.session.data.size).toBe(0);
      // The log names the provider and says what happened; nothing of the document is in it.
      expect(bad.logger.entries).toEqual([`warn An OAuth provider found endpoints that are not usable. ${JSON.stringify({ provider: 'idp', reason })}`]);
    }
    const bug = oauthWith({ overrides: { endpoints: async () => { throw new RangeError('bug'); } } });
    expect(await rejection(bug.oauth.redirect('idp'))).toBeInstanceOf(RangeError);
    expect(bug.session.data.size).toBe(0);
  });

  it('reaches a discovery inside your network only through allowAddresses', async () => {
    const discovery = 'https://idp.corp.example/.well-known/config';
    const document = { authorizeUrl: 'https://idp.corp.example/authorize', tokenUrl: 'https://idp.corp.example/token' };
    const start = (allowAddresses?: readonly string[]) => {
      const parts = oauthWith({
        overrides: { ...(allowAddresses === undefined ? {} : { allowAddresses }), endpoints: async (http) => (await http.json(discovery)) as never },
      });
      parts.http.respond(discovery, Response.json(document)).dns('idp.corp.example', ['10.20.0.5']);
      return parts;
    };
    const without = start();
    expect(await without.oauth.redirect('idp')).toEqual({ ok: false, error: { kind: 'unavailable' } });
    without.http.assertNothingSent();
    const wrong = start(['10.30.0.0/16']);
    expect(await wrong.oauth.redirect('idp')).toEqual({ ok: false, error: { kind: 'unavailable' } });
    wrong.http.assertNothingSent();
    const allowed = start(['10.20.0.0/16']);
    const result = await allowed.oauth.redirect('idp');
    expect(result.ok && result.value.origin).toBe('https://idp.corp.example');
    allowed.http.assertSentCount(1);
  });

  it('accepts plain http to a loopback host only where the app is local', async () => {
    for (const [appUrl, expected] of [
      ['http://localhost:3000', 'http://localhost:3000/auth/idp/callback'],
      ['http://localhost:3000/base/', 'http://localhost:3000/base/auth/idp/callback'],
    ] as const) {
      const result = await oauthWith({ local: true, appUrl }).oauth.redirect('idp');
      expect(result.ok && result.value.searchParams.get('redirect_uri'), appUrl).toBe(expected);
      expect(errorCodeOf(await rejection(oauthWith({ local: false, appUrl }).oauth.redirect('idp'))), appUrl).toBe('A10');
    }
    expect(errorCodeOf(await rejection(oauthWith({ local: true, appUrl: 'http://app.example.com' }).oauth.redirect('idp')))).toBe('A10');
    // The same for the override of the callback address.
    const own = await oauthWith({ local: true, redirectUrl: 'http://localhost:3000/cb' }).oauth.redirect('idp');
    expect(own.ok && own.value.searchParams.get('redirect_uri')).toBe('http://localhost:3000/cb');
    expect(errorCodeOf(await rejection(oauthWith({ local: false, redirectUrl: 'http://localhost:3000/cb' }).oauth.redirect('idp')))).toBe('A10');
    expect(errorCodeOf(await rejection(oauthWith({ local: true, redirectUrl: 'http://app.example.com/cb' }).oauth.redirect('idp')))).toBe('A10');
  });

  it('lets the provider\'s discovery call a loopback address with plain http only where the app is local', async () => {
    const discovery = 'http://127.0.0.1:9/x';
    const start = (local: boolean) => {
      const parts = oauthWith({
        local,
        appUrl: 'https://app.example.com',
        overrides: { allowAddresses: ['127.0.0.0/8'], endpoints: async (http) => (await http.json(discovery)) as never },
      });
      parts.http.respond(discovery, Response.json({ authorizeUrl: 'https://id2.example.com/authorize', tokenUrl: 'https://id2.example.com/token' }));
      return parts;
    };
    const local = start(true);
    const result = await local.oauth.redirect('idp');
    expect(result.ok && result.value.origin).toBe('https://id2.example.com');
    local.http.assertSentCount(1);
    const production = start(false);
    expect(errorCodeOf(await rejection(production.oauth.redirect('idp')))).toBe('A10');
    production.http.assertNothingSent();
    expect(production.session.data.size).toBe(0);
  });

  it('passes on what fails while the session resolves, and takes only a missing session package for a setup mistake', async () => {
    class BrokenSessionProvider {
      static config = [SessionConfig];
      register(container: Container): void {
        container.scoped(Session, () => {
          throw new Error('the session store is down');
        });
      }
    }
    const app = await oauthApp([providerBringing('Mine', { idp: defineOAuthProvider(definition()) }), BrokenSessionProvider], activeEnv('idp'));
    const error = await rejection(app.application.container.createScope().make(OAuth).redirect('idp'));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('the session store is down');
    expect(errorCodeOf(error)).toBeUndefined();
  });

  it('is local in development and test, from the container', async () => {
    for (const NODE_ENV of ['development', 'test']) {
      const sessions = [fakeSession()];
      const app = await oauthApp([providerBringing('Mine', { idp: defineOAuthProvider(definition()) }), sessionsFrom(sessions)], { ...activeEnv('idp'), APP_URL: 'http://localhost:3000', NODE_ENV });
      const result = await app.application.container.createScope().make(OAuth).redirect('idp');
      expect(result.ok && result.value.searchParams.get('redirect_uri'), NODE_ENV).toBe('http://localhost:3000/auth/idp/callback');
    }
    // Production refuses at the start, before a flow can be asked for.
    const refused = await oauthApp([providerBringing('Mine', { idp: defineOAuthProvider(definition()) })], { ...activeEnv('idp'), APP_URL: 'http://localhost:3000', NODE_ENV: 'production' }).then(() => undefined, (error: unknown) => error);
    expect(errorCodeOf(refused)).toBe('A11');
  });

  it('throws A10 for SESSION_SAME_SITE=strict from the container, and without the session package', async () => {
    const sessions = [fakeSession()];
    const strict = await oauthApp([providerBringing('Mine', { idp: defineOAuthProvider(definition()) }), sessionsFrom(sessions)], { ...activeEnv('idp'), SESSION_SAME_SITE: 'strict' });
    const error = await rejection(strict.application.container.createScope().make(OAuth).redirect('idp'));
    expect(errorCodeOf(error)).toBe('A10');
    expect(error).toBeInstanceOf(OAuthSetupError);
    expect(sessions[0]!.data.size).toBe(0);
    // No session package: the services of an unrelated app resolve, the flow asks for the session by name.
    const bare = await oauthApp([providerBringing('Mine', { idp: defineOAuthProvider(definition()) })], activeEnv('idp'));
    const scope = bare.application.container.createScope();
    expect(scope.make(OAuth).providers()).toEqual([{ name: 'idp', label: 'Example' }]);
    const missing = await rejection(scope.make(OAuth).redirect('idp'));
    expect(errorCodeOf(missing)).toBe('A10');
    expect((missing as Error).message).toContain('StartSession');
  });

  it('lists providers and answers unknown-provider without the session or the client, and asks for the session only to start a flow', async () => {
    const { oauth } = oauthWith({ unbound: true });
    expect(oauth.providers()).toEqual([{ name: 'idp', label: 'Example' }]);
    expect(await oauth.redirect('nobody')).toEqual({ ok: false, error: { kind: 'unknown-provider' } });
    const error = await rejection(oauth.redirect('idp'));
    expect(errorCodeOf(error)).toBe('A10');
    expect((error as Error).message).toContain('StartSession');
  });

  it('adds options.scopes to the configured scopes without duplicates', async () => {
    const scopeOf = async (parts: Parameters<typeof oauthWith>[0], scopes?: readonly string[]) => {
      const result = await oauthWith(parts).oauth.redirect('idp', scopes === undefined ? {} : { scopes });
      return result.ok ? result.value.searchParams.get('scope') : undefined;
    };
    expect(await scopeOf({}, ['email', 'profile', 'email'])).toBe('profile email');
    // OAUTH_<N>_SCOPES replaces the scopes of the definition.
    expect(await scopeOf({ scopes: ['openid', 'email'] }, ['email', 'groups'])).toBe('openid email groups');
    expect(await scopeOf({ overrides: { scopeSeparator: ',' } }, ['email'])).toBe('profile,email');
    await expect(oauthWith().oauth.redirect('idp', { scopes: ['a b'] })).rejects.toThrow(TypeError);
    // The limits of a flow, so that a redirect that answers ok is one the callback takes: 64 scopes of 255 characters, a hole is no scope.
    const many = (count: number) => Array.from({ length: count }, (_, i) => `s${i}`);
    await expect(oauthWith().oauth.redirect('idp', { scopes: many(65) })).rejects.toThrow(TypeError);
    await expect(oauthWith().oauth.redirect('idp', { scopes: ['x'.repeat(256)] })).rejects.toThrow(TypeError);
    await expect(oauthWith().oauth.redirect('idp', { scopes: Object.assign([], { length: 2 }) as never })).rejects.toThrow(TypeError);
    // Together with the provider's own scopes (one: profile): 64 is the most, and a duplicate counts once.
    expect((await oauthWith().oauth.redirect('idp', { scopes: many(63) })).ok).toBe(true);
    expect((await oauthWith().oauth.redirect('idp', { scopes: [...many(63), 'profile'] })).ok).toBe(true);
    await expect(oauthWith().oauth.redirect('idp', { scopes: many(64) })).rejects.toThrow(TypeError);
  });

  it('puts the prompt option into the URL and refuses any other value', async () => {
    const { oauth } = oauthWith();
    for (const prompt of ['select_account', 'consent'] as const) {
      const result = await oauth.redirect('idp', { prompt });
      expect(result.ok && result.value.searchParams.get('prompt')).toBe(prompt);
    }
    const plain = await oauth.redirect('idp');
    expect(plain.ok && plain.value.searchParams.has('prompt')).toBe(false);
    for (const prompt of ['none', 'login', '', 'Consent', 1]) {
      await expect(oauth.redirect('idp', { prompt } as never), String(prompt)).rejects.toThrow(TypeError);
    }
  });

  it('refuses a user id that is no whole number and no text, and a key that is not an option', async () => {
    const { oauth, session } = oauthWith();
    for (const userId of [{}, Number.NaN, Number.POSITIVE_INFINITY, 1.5, 2 ** 60, '', null, true]) {
      await expect(oauth.redirect('idp', { userId } as never), String(userId)).rejects.toThrow(TypeError);
    }
    // Through a variable, as a JS caller or a wide type gets here: a misspelt key is no quiet unbound flow.
    const misspelt: Record<string, unknown> = { userid: 7, Intent: 'link' };
    const error = await rejection(oauth.redirect('idp', misspelt));
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toMatch(/"userid", "Intent".*intent, userId, account, scopes, prompt/);
    expect(session.data.size).toBe(0);
    for (const userId of [0, -3, 'abc']) expect((await oauth.redirect('idp', { userId })).ok, String(userId)).toBe(true);
  });

  it('writes no state, verifier or URL to the log', async () => {
    const logger = recordingLogger();
    const ok = oauthWith({ logger, overrides: { nonce: true } });
    const result = await ok.oauth.redirect('idp', { userId: 7 });
    if (!result.ok) throw new Error('expected a URL');
    const flow = flowOf(ok.session);
    const down = oauthWith({ logger, overrides: { endpoints: async () => { throw new OAuthHttpError(502); } } });
    expect(await down.oauth.redirect('idp')).toEqual({ ok: false, error: { kind: 'unavailable' } });
    expect(logger.entries).toEqual([
      'debug Opened an OAuth flow. {"provider":"idp","intent":"sign-in"}',
      'warn An OAuth provider could not be reached to find its endpoints. {"provider":"idp","status":502}',
    ]);
    const log = logger.entries.join('\n');
    for (const secret of [flow.state, flow.verifier!, flow.nonce!, result.value.searchParams.get('code_challenge')!, result.value.href, 'id.example.com/authorize', 'redirect_uri']) {
      expect(log).not.toContain(secret);
    }
  });

  it('is resolved per request from the container, with the app, the session and the clock of that request', async () => {
    const sessions = [fakeSession(), fakeSession()];
    const app = await oauthApp([providerBringing('Mine', { idp: defineOAuthProvider(definition()) }), sessionsFrom(sessions)], { ...activeEnv('idp'), SESSION_SAME_SITE: 'lax' });
    app.freeze(1_700_000_000_000);
    const first = app.application.container.createScope();
    const second = app.application.container.createScope();
    expect(first.make(OAuth)).toBe(first.make(OAuth));
    expect(first.make(OAuth)).not.toBe(second.make(OAuth));
    const result = await first.make(OAuth).redirect('idp');
    expect(result.ok && result.value.searchParams.get('redirect_uri')).toBe('https://app.example.com/auth/idp/callback');
    expect(sessions[0]!.data.size).toBe(1);
    expect(sessions[1]!.data.size).toBe(0);
    expect(first.make(OAuth).providers()).toEqual([{ name: 'idp', label: 'Example' }]);
    // The clock of the app is the clock the flow is stamped with.
    expect(flowOf(sessions[0]!).issuedAt).toBe(1_700_000_000);
  });
});

import { errorCodeOf } from '@marmeon/core';
import { Session, type SessionConfig } from '@marmeon/session';
import { MemorySessionStore, plainSessionCodec } from '@marmeon/session/internal';
import { describe, expect, it } from 'vitest';
import { OAuthSetupError } from './config.ts';
import { flowKey, type OpenFlow } from './flow.ts';
import { OAuthHttpError } from './http.ts';
import { TOKEN_URL, started, tokenResponse } from './test-helpers/callback.ts';
import { fakeSession, oauthWith, recordingLogger } from './test-helpers/flow.ts';
import { verifiedInfo } from './verified.ts';

const present = (session: { data: Map<string, unknown> }): boolean => session.data.has(flowKey('idp'));
const body = async (request: Request): Promise<URLSearchParams> => new URLSearchParams(await request.clone().text());
const kindOf = (result: { ok: boolean; error?: { kind: string } }): string | undefined => (result.ok ? undefined : result.error?.kind);

describe('OAuth.callback() takes the flow', () => {
  it('takes the flow out of the session before checking anything, so a state works once even when the check fails', async () => {
    const { oauth, session, query, http } = await started();
    expect(present(session)).toBe(true);
    const wrong = await oauth.callback('idp', query({ state: 'wrong' }));
    expect(kindOf(wrong)).toBe('invalid');
    expect(present(session)).toBe(false);
    // The right state, now: the flow is gone.
    expect(kindOf(await oauth.callback('idp', query()))).toBe('no-flow');
    http.assertNothingSent();
  });

  it('answers no-flow for a second callback with the same state', async () => {
    const { oauth, query, http } = await started();
    expect((await oauth.callback('idp', query())).ok).toBe(true);
    expect(await oauth.callback('idp', query())).toEqual({ ok: false, error: { kind: 'no-flow' } });
    http.assertSentCount(1);
  });

  it('answers expired after ten minutes', async () => {
    const { oauth, query, http, clock } = await started();
    clock.freeze(1_700_000_000_000 + 600_000);
    expect(await oauth.callback('idp', query())).toEqual({ ok: false, error: { kind: 'expired' } });
    http.assertNothingSent();
  });

  it('still serves a flow in its last second', async () => {
    const { oauth, query, clock } = await started();
    clock.freeze(1_700_000_000_000 + 599_000);
    expect((await oauth.callback('idp', query())).ok).toBe(true);
  });

  it('refuses a flow of another provider', async () => {
    const { oauth, session, query, http, flow } = await started();
    session.data.set(flowKey('idp'), { ...flow, provider: 'other' });
    expect(await oauth.callback('idp', query())).toEqual({ ok: false, error: { kind: 'invalid' } });
    http.assertNothingSent();
  });

  it('refuses a flow started for one user in the session of another, of a guest, and a guest flow in a signed-in session', async () => {
    for (const [started_for, signed_in, expected] of [
      [7, 8, 'invalid'],
      [7, undefined, 'invalid'],
      [undefined, 8, 'invalid'],
      [7, 7, undefined],
      ['7', 7, undefined],
      [undefined, undefined, undefined],
    ] as const) {
      const { oauth, query, http } = await started({}, started_for === undefined ? {} : { userId: started_for });
      const result = await oauth.callback('idp', query(), signed_in === undefined ? {} : { userId: signed_in });
      expect(kindOf(result), `${String(started_for)} / ${String(signed_in)}`).toBe(expected);
      if (expected !== undefined) http.assertNothingSent();
    }
  });

  it('refuses a missing state, a wrong state and a state of another length without exchanging the code', async () => {
    for (const state of [undefined, '', 'wrong', 'x', 'x'.repeat(200)]) {
      const { oauth, query, http } = await started();
      expect(await oauth.callback('idp', query({ state })), String(state)).toEqual({ ok: false, error: { kind: 'invalid' } });
      http.assertNothingSent();
    }
    // A state that is right but sent twice is not the answer to this flow either.
    const { oauth, flow, query, http } = await started();
    const twice = query();
    twice.append('state', flow.state);
    expect(kindOf(await oauth.callback('idp', twice))).toBe('invalid');
    http.assertNothingSent();
  });

  it('refuses an iss parameter that is not the provider\'s issuer', async () => {
    const overrides = { endpoints: { authorizeUrl: 'https://id.example.com/authorize', tokenUrl: TOKEN_URL, issuer: 'https://id.example.com' } };
    for (const iss of ['https://evil.example', 'https://id.example.com/', '']) {
      const { oauth, query, http } = await started({ overrides });
      expect(kindOf(await oauth.callback('idp', query({ iss }))), iss).toBe('invalid');
      http.assertNothingSent();
    }
    const good = await started({ overrides });
    expect((await good.oauth.callback('idp', good.query({ iss: 'https://id.example.com' }))).ok).toBe(true);
    // Without an issuer of the provider there is nothing to compare, and no iss is no refusal.
    const open = await started();
    expect((await open.oauth.callback('idp', open.query({ iss: 'https://anything.example' }))).ok).toBe(true);
    const silent = await started({ overrides });
    expect((await silent.oauth.callback('idp', silent.query())).ok).toBe(true);
  });

  it('refuses a repeated iss parameter, whatever it holds, and sends nothing', async () => {
    const overrides = { endpoints: { authorizeUrl: 'https://id.example.com/authorize', tokenUrl: TOKEN_URL, issuer: 'https://id.example.com' } };
    for (const [first, second] of [['https://id.example.com', 'https://id.example.com'], ['https://id.example.com', 'https://evil.example'], ['https://evil.example', 'https://id.example.com']]) {
      const { oauth, query, http } = await started({ overrides });
      const params = query({ iss: first });
      params.append('iss', second!);
      expect(await oauth.callback('idp', params), `${first} ${second}`).toEqual({ ok: false, error: { kind: 'invalid' } });
      http.assertNothingSent();
    }
  });

  it('answers invalid for a wrong user and a wrong state, for the reason user', async () => {
    const logger = recordingLogger();
    const { oauth, query, http } = await started({ logger }, { userId: 7 });
    expect(await oauth.callback('idp', query({ state: 'wrong' }), { userId: 8 })).toEqual({ ok: false, error: { kind: 'invalid' } });
    http.assertNothingSent();
    expect(logger.entries.filter((entry) => entry.startsWith('warn')).map((entry) => /"reason":"([^"]+)"/.exec(entry)![1])).toEqual(['user']);
  });

  it('answers invalid for a wrong state first, whatever else is wrong with the answer', async () => {
    for (const extra of [{ error: 'access_denied' }, { code: 'c'.repeat(3000) }, { code: undefined }, { error: 'server_error', iss: 'https://evil.example' }]) {
      const { oauth, query, http } = await started();
      expect(await oauth.callback('idp', query({ state: 'wrong', ...extra })), JSON.stringify(extra)).toEqual({ ok: false, error: { kind: 'invalid' } });
      http.assertNothingSent();
    }
    // A foreign issuer comes before the provider's own error.
    const overrides = { endpoints: { authorizeUrl: 'https://id.example.com/authorize', tokenUrl: TOKEN_URL, issuer: 'https://id.example.com' } };
    const issued = await started({ overrides });
    expect(await issued.oauth.callback('idp', issued.query({ iss: 'https://evil.example', error: 'access_denied' }))).toEqual({ ok: false, error: { kind: 'invalid' } });
  });

  it('answers cancelled for error=access_denied and exchanges nothing', async () => {
    const { oauth, query, http, session } = await started();
    expect(await oauth.callback('idp', query({ error: 'access_denied', code: undefined }))).toEqual({ ok: false, error: { kind: 'cancelled' } });
    http.assertNothingSent();
    expect(present(session)).toBe(false);
  });

  it('answers provider-error with the code only when it is a plain code, and exchanges nothing', async () => {
    for (const [error, expected] of [
      ['server_error', 'server_error'],
      ['temporarily_unavailable', 'temporarily_unavailable'],
      ['<script>alert(1)</script>', 'unknown'],
      ['x'.repeat(65), 'unknown'],
      ['', 'unknown'],
    ] as const) {
      const { oauth, query, http } = await started();
      expect(await oauth.callback('idp', query({ error })), error).toEqual({ ok: false, error: { kind: 'provider-error', error: expected } });
      http.assertNothingSent();
    }
  });

  it('never returns error_description', async () => {
    const { oauth, query } = await started();
    const text = 'The account of ada@example.com is locked';
    const result = await oauth.callback('idp', query({ error: 'access_denied', error_description: text }));
    expect(JSON.stringify(result)).not.toContain('ada@example.com');
    const other = await started();
    const second = await other.oauth.callback('idp', other.query({ error: 'server_error', error_description: text }));
    expect(JSON.stringify(second)).not.toContain('locked');
  });

  it('refuses a missing, empty or over-long code', async () => {
    for (const code of [undefined, '', 'c'.repeat(2049)]) {
      const { oauth, query, http } = await started();
      expect(await oauth.callback('idp', query({ code })), String(code)).toEqual({ ok: false, error: { kind: 'invalid' } });
      http.assertNothingSent();
    }
    const edge = await started();
    expect((await edge.oauth.callback('idp', edge.query({ code: 'c'.repeat(2048) }))).ok).toBe(true);
  });

  it('answers invalid on a read-only session and leaves the flow in place', async () => {
    const store = new MemorySessionStore();
    const open = async <T>(id: string | undefined, use: (session: Session) => T | Promise<T>): Promise<{ id: string; value: T }> => {
      const session = new Session(store, { lifetimeMinutes: 120 } as SessionConfig, plainSessionCodec);
      await session.start(id);
      const value = await use(session);
      await session.save();
      return { id: session.id, value };
    };
    let state = '';
    const first = await open(undefined, async (session) => {
      const { oauth, flow } = await started({ session });
      state = flow.state;
      void oauth;
    });
    const params = new URLSearchParams({ code: 'the-code', state });
    // A real session that this request may not write: nothing is taken, so it cannot be spent twice, and nothing is exchanged.
    const locked = async () =>
      (await open(first.id, async (session) => {
        session.lock(() => false);
        const made = oauthWith({ session });
        const result = await made.oauth.callback('idp', params);
        made.http.assertNothingSent();
        return result;
      })).value;
    expect(await locked()).toEqual({ ok: false, error: { kind: 'invalid' } });
    expect(await locked()).toEqual({ ok: false, error: { kind: 'invalid' } });
    // Still there for the request that may spend it, once.
    const spend = async () =>
      (await open(first.id, (session) => {
        const made = oauthWith({ session });
        made.http.respond(TOKEN_URL, () => tokenResponse());
        return made.oauth.callback('idp', params);
      })).value;
    expect((await spend()).ok).toBe(true);
    expect(await spend()).toEqual({ ok: false, error: { kind: 'no-flow' } });
  });

  it('answers invalid on a session that is not started, without taking anything', async () => {
    const session = fakeSession({ started: false });
    const { oauth, http } = oauthWith({ session });
    expect(await oauth.callback('idp', new URLSearchParams({ code: 'c', state: 's' }))).toEqual({ ok: false, error: { kind: 'invalid' } });
    http.assertNothingSent();
  });

  it('answers unknown-provider for an inactive provider without touching the session', async () => {
    const { oauth, session, query, http } = await started();
    for (const name of ['other', '', 'IDP', '__proto__', 'constructor']) {
      expect(await oauth.callback(name, query()), name).toEqual({ ok: false, error: { kind: 'unknown-provider' } });
    }
    expect(present(session)).toBe(true);
    http.assertNothingSent();
  });

  it('throws A10 for an app without a session package, and a TypeError for options of the wrong form', async () => {
    const { oauth } = oauthWith({ unbound: true });
    const error = await oauth.callback('idp', new URLSearchParams()).then(() => undefined, (cause: unknown) => cause);
    expect(errorCodeOf(error)).toBe('A10');
    const bound = oauthWith();
    await expect(bound.oauth.callback('idp', new URLSearchParams(), { userid: 7 } as never)).rejects.toThrow(TypeError);
    await expect(bound.oauth.callback('idp', new URLSearchParams(), { userId: {} } as never)).rejects.toThrow(TypeError);
    await expect(bound.oauth.callback('idp', 'code=1' as never)).rejects.toThrow(TypeError);
  });
});

describe('OAuth.callback() trades the code', () => {
  it('exchanges with client_secret_post and with client_secret_basic, url-encoding id and secret', async () => {
    const post = await started();
    await post.oauth.callback('idp', post.query());
    const sent = await body(post.http.requests[0]!);
    expect(sent.get('client_id')).toBe('client');
    expect(sent.get('client_secret')).toBe('secret');
    expect(post.http.requests[0]!.headers.get('authorization')).toBeNull();
    expect(post.http.requests[0]!.method).toBe('POST');
    expect(sent.get('grant_type')).toBe('authorization_code');
    expect(sent.get('code')).toBe('the-code');

    const basic = await started({ overrides: { clientAuth: 'client_secret_basic' } });
    await basic.oauth.callback('idp', basic.query());
    const request = basic.http.requests[0]!;
    expect(request.headers.get('authorization')).toBe(`Basic ${Buffer.from('client:secret').toString('base64')}`);
    const form = await body(request);
    expect(form.get('client_id')).toBe('client');
    expect(form.has('client_secret')).toBe(false);
  });

  it('url-encodes an id and a secret that hold reserved characters in the Basic header', async () => {
    const made = oauthWith({ overrides: { clientAuth: 'client_secret_basic' } });
    // The credentials are set on the resolved provider by `oauthWith`: use a provider whose id and secret need encoding.
    const { OAuth } = await import('./oauth.ts');
    const { OAuthProviders } = await import('./registry.ts');
    const { definition } = await import('./test-helpers/app.ts');
    const { TestClock } = await import('@marmeon/core/testing');
    const clock = new TestClock();
    clock.freeze(1_700_000_000_000);
    const oauth = new OAuth(
      new OAuthProviders([
        {
          name: 'idp',
          label: 'Example',
          definition: definition({ clientAuth: 'client_secret_basic' }),
          credentials: { clientId: 'a b:c', clientSecret: 's%é+/', redirectUrl: undefined, scopes: undefined, issuer: undefined, options: {} },
        },
      ]),
      () => made.session,
      () => ({ sameSite: 'lax' }) as SessionConfig,
      () => made.http,
      { appUrl: 'https://app.example.com' } as never,
      clock,
      recordingLogger(),
      false,
    );
    made.http.respond(TOKEN_URL, () => tokenResponse());
    await oauth.redirect('idp');
    const flow = made.session.data.get(flowKey('idp')) as OpenFlow;
    await oauth.callback('idp', new URLSearchParams({ code: 'c', state: flow.state }));
    const header = made.http.requests[0]!.headers.get('authorization')!;
    expect(Buffer.from(header.replace('Basic ', ''), 'base64').toString()).toBe('a+b%3Ac:s%25%C3%A9%2B%2F');
  });

  it('sends the code_verifier of this flow', async () => {
    const { oauth, query, http, flow } = await started();
    await oauth.callback('idp', query());
    const sent = await body(http.requests[0]!);
    expect(sent.get('code_verifier')).toBe(flow.verifier);
    expect(flow.verifier).toBeDefined();
    const plain = await started({ overrides: { pkce: false } });
    await plain.oauth.callback('idp', plain.query());
    expect((await body(plain.http.requests[0]!)).has('code_verifier')).toBe(false);
  });

  it('sends the same redirect_uri as the authorization request', async () => {
    for (const parts of [{}, { redirectUrl: 'https://login.example.com/back' }, { appUrl: 'https://app.example.com/base/' }]) {
      const made = await started(parts);
      const authorization = await made.oauth.redirect('idp');
      if (!authorization.ok) throw new Error('expected a URL');
      const flow = made.session.data.get(flowKey('idp')) as OpenFlow;
      await made.oauth.callback('idp', new URLSearchParams({ code: 'c', state: flow.state }));
      expect((await body(made.http.requests[0]!)).get('redirect_uri')).toBe(authorization.value.searchParams.get('redirect_uri'));
    }
  });

  it('answers rejected for a 400 and for a 200 with an error field', async () => {
    for (const reply of [
      () => Response.json({ error: 'invalid_grant', error_description: 'secret detail' }, { status: 400 }),
      () => new Response('nope', { status: 401 }),
      () => Response.json({ error: 'invalid_grant' }),
      () => tokenResponse({ error: 'invalid_grant' }),
    ]) {
      const { oauth, query, http } = await started();
      http.respond(TOKEN_URL, reply);
      const result = await oauth.callback('idp', query());
      expect(result).toEqual({ ok: false, error: { kind: 'rejected' } });
    }
  });

  it('answers unavailable for a timeout and a 502', async () => {
    const timeout = await started();
    timeout.http.failNext('timeout');
    expect(await timeout.oauth.callback('idp', timeout.query())).toEqual({ ok: false, error: { kind: 'unavailable' } });
    const gateway = await started();
    gateway.http.respond(TOKEN_URL, () => new Response('bad gateway', { status: 502 }));
    expect(await gateway.oauth.callback('idp', gateway.query())).toEqual({ ok: false, error: { kind: 'unavailable' } });
  });

  it('answers unavailable when discovery of the endpoints gives no answer', async () => {
    const overrides = {
      endpoints: async (http: { json(url: string): Promise<unknown> }) => {
        await http.json('https://id.example.com/.well-known/openid-configuration');
        return { authorizeUrl: 'https://id.example.com/authorize', tokenUrl: TOKEN_URL };
      },
    };
    const made = oauthWith({ overrides });
    made.http.respond('https://id.example.com/.well-known/openid-configuration', () => Response.json({}));
    made.http.respond(TOKEN_URL, () => tokenResponse());
    await made.oauth.redirect('idp');
    const flow = made.session.data.get(flowKey('idp')) as OpenFlow;
    made.http.respond('https://id.example.com/.well-known/openid-configuration', () => new Response('down', { status: 503 }));
    expect(await made.oauth.callback('idp', new URLSearchParams({ code: 'c', state: flow.state }))).toEqual({ ok: false, error: { kind: 'unavailable' } });
  });

  it('answers invalid-response for a token type other than bearer and for a missing access token', async () => {
    for (const reply of [
      () => tokenResponse({ token_type: 'mac' }),
      () => tokenResponse({ token_type: undefined }),
      () => tokenResponse({ access_token: undefined }),
      () => tokenResponse({ access_token: '' }),
      () => tokenResponse({ access_token: 42 }),
      () => Response.json(['token']),
      () => new Response('<html>not json</html>'),
    ]) {
      const { oauth, query, http } = await started();
      http.respond(TOKEN_URL, reply);
      expect(await oauth.callback('idp', query())).toEqual({ ok: false, error: { kind: 'invalid-response' } });
    }
    const lower = await started();
    lower.http.respond(TOKEN_URL, () => tokenResponse({ token_type: 'bEaReR' }));
    expect((await lower.oauth.callback('idp', lower.query())).ok).toBe(true);
  });

  it('hands the tokens, their expiry and their scopes to profile()', async () => {
    let seen: unknown;
    const { oauth, query, http, clock } = await started({
      overrides: {
        nonce: true,
        profile: async (input) => {
          seen = input;
          return {};
        },
      },
    });
    http.respond(TOKEN_URL, () => tokenResponse({ refresh_token: 'refresh-secret', id_token: 'id-secret', scope: 'a,b c' }));
    const result = await oauth.callback('idp', query());
    expect(result.ok).toBe(true);
    expect(seen).toMatchObject({
      tokens: { accessToken: 'access-secret', refreshToken: 'refresh-secret', idToken: 'id-secret', scopes: ['a', 'b', 'c'], expiresAt: clock.now() + 3_600_000 },
      clientId: 'client',
      now: clock.now(),
    });
    expect((seen as { nonce: string }).nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('answers with the scopes that were asked for when the provider names none', async () => {
    const { oauth, query } = await started();
    const result = await oauth.callback('idp', query());
    expect(result.ok && result.value.user.tokens.scopes).toEqual(['profile']);
  });
});

describe('OAuth.callback() asks who the person is', () => {
  it('answers unavailable for a profile request that fails with 5xx or cannot connect, and invalid-response for anything else', async () => {
    for (const [thrown, expected] of [
      [new OAuthHttpError(503), 'unavailable'],
      [new OAuthHttpError(401), 'invalid-response'],
      [new OAuthHttpError(0), 'invalid-response'],
      [new Error('quotes access-secret'), 'invalid-response'],
    ] as const) {
      const logger = recordingLogger();
      const { oauth, query } = await started({
        logger,
        overrides: {
          profile: async () => {
            throw thrown;
          },
        },
      });
      expect(kindOf(await oauth.callback('idp', query())), String(thrown)).toBe(expected);
      expect(logger.entries.join('\n')).not.toContain('access-secret');
    }
  });

  it('answers invalid-response when mapUser throws or the profile has no usable id', async () => {
    for (const mapUser of [
      () => {
        throw new Error('boom');
      },
      () => null,
      () => ({ id: '', email: null, emailVerified: false, name: null, nickname: null, avatar: null }),
      () => ({ id: 42, email: null }),
    ]) {
      const { oauth, query } = await started({ overrides: { mapUser: mapUser as never } });
      expect(await oauth.callback('idp', query())).toEqual({ ok: false, error: { kind: 'invalid-response' } });
    }
  });

  it('returns the user with the intent, and marks it as the result of this flow', async () => {
    const { oauth, query } = await started({ overrides: { profile: async () => ({ sub: '9' }), mapUser: () => ({ id: ' 9 ', email: ' Ada@Example.COM ', emailVerified: true, name: 'Ada', nickname: null, avatar: null }) } }, { intent: 'link', userId: 7 });
    const result = await oauth.callback('idp', query(), { userId: 7 });
    if (!result.ok) throw new Error('expected a user');
    expect(result.value.intent).toBe('link');
    expect(result.value.user).toMatchObject({ provider: 'idp', id: '9', email: 'ada@example.com', emailVerified: true, raw: { sub: '9' } });
    expect(verifiedInfo(result.value.user)).toMatchObject({ intent: 'link', flowUserId: '7', subject: { provider: 'idp', id: '9' } });
    expect(Object.isFrozen(result.value.user)).toBe(true);
  });
});

describe('what callback() logs', () => {
  it('logs neither code, token nor state on any failure', async () => {
    const logger = recordingLogger();
    const secrets = ['the-code-secret', 'access-secret', 'refresh-secret'];
    const cases: [string, (state: string) => URLSearchParams, (http: ReturnType<typeof oauthWith>['http']) => void][] = [
      ['state', () => new URLSearchParams({ code: secrets[0]!, state: 'wrong-state-value' }), () => undefined],
      ['rejected', (state) => new URLSearchParams({ code: secrets[0]!, state }), (http) => http.respond(TOKEN_URL, () => Response.json({ error: 'invalid_grant', error_description: secrets[1] }, { status: 400 }))],
      ['unavailable', (state) => new URLSearchParams({ code: secrets[0]!, state }), (http) => http.respond(TOKEN_URL, () => new Response(secrets[1], { status: 502 }))],
      ['invalid-response', (state) => new URLSearchParams({ code: secrets[0]!, state }), (http) => http.respond(TOKEN_URL, () => tokenResponse({ access_token: secrets[1], token_type: 'mac', refresh_token: secrets[2] }))],
      ['provider-error', (state) => new URLSearchParams({ state, error: 'server_error', error_description: secrets[1]! }), () => undefined],
    ];
    const states: string[] = [];
    for (const [label, params, prepare] of cases) {
      const { oauth, flow, http } = await started({ logger });
      states.push(flow.state);
      prepare(http);
      const result = await oauth.callback('idp', params(flow.state));
      expect(result.ok, label).toBe(false);
    }
    const log = logger.entries.join('\n');
    expect(log).toContain('"provider":"idp"');
    for (const secret of [...secrets, 'wrong-state-value', ...states]) expect(log).not.toContain(secret);
  });
});

describe('OAuth.callback() with an app that is set up wrongly', () => {
  it('throws A10 for a missing callback address, after the flow is spent', async () => {
    const first = await started();
    const made = oauthWith({ appUrl: undefined, session: first.session });
    made.http.respond(TOKEN_URL, () => tokenResponse());
    const error = await made.oauth.callback('idp', first.query()).then(() => undefined, (cause: unknown) => cause);
    expect(errorCodeOf(error)).toBe('A10');
    expect(present(first.session)).toBe(false);
    made.http.assertNothingSent();
    expect(await made.oauth.callback('idp', first.query())).toEqual({ ok: false, error: { kind: 'no-flow' } });
  });

  it('throws A10 for an address that http refuses in profile(), where the app is not local', async () => {
    const overrides = {
      allowAddresses: ['127.0.0.0/8'],
      profile: async ({ http }: { http: { json(url: string): Promise<unknown> } }) => http.json('http://127.0.0.1:9000/user'),
    };
    const { oauth, query } = await started({ overrides, local: false });
    expect(errorCodeOf(await oauth.callback('idp', query()).then(() => undefined, (cause: unknown) => cause))).toBe('A10');
  });

  it('lets the token and profile requests reach a loopback address with plain http only where the app is local, and only when allowed', async () => {
    const loopback = 'http://127.0.0.1:9000/token';
    const profile = 'http://127.0.0.1:9000/user';
    const overrides = (allow: boolean) => ({
      ...(allow ? { allowAddresses: ['127.0.0.0/8'] } : {}),
      endpoints: { authorizeUrl: 'https://id.example.com/authorize', tokenUrl: loopback },
      profile: async ({ http }: { http: { json(url: string): Promise<unknown> } }) => http.json(profile),
      mapUser: (raw: unknown) => ({ id: String((raw as { id: string }).id), email: null, emailVerified: false, name: null, nickname: null, avatar: null }),
    });
    const run = async (local: boolean, allow: boolean) => {
      const made = await started({ local, overrides: overrides(allow) });
      made.http.respond(loopback, () => tokenResponse());
      made.http.respond(profile, () => Response.json({ id: 'u-1' }));
      const result = await made.oauth.callback('idp', made.query()).then((value) => value, (cause: unknown) => cause);
      return { result, http: made.http };
    };
    const good = await run(true, true);
    expect((good.result as { ok: boolean }).ok).toBe(true);
    good.http.assertSentCount(2);
    const production = await run(false, true);
    expect(errorCodeOf(production.result)).toBe('A10');
    production.http.assertNothingSent();
    // A private address nobody allowed is refused by the client: the provider cannot be reached.
    const unlisted = await run(true, false);
    expect(unlisted.result).toEqual({ ok: false, error: { kind: 'unavailable' } });
    unlisted.http.assertNothingSent();
  });

  it('answers the scopes that were asked for when the provider names none', async () => {
    const { oauth, query } = await started({ scopes: ['a', 'b'] });
    const result = await oauth.callback('idp', query());
    expect(result.ok && result.value.user.tokens.scopes).toEqual(['a', 'b']);
  });
});

describe('OAuth.callback() with a provider that misbehaves', () => {
  const user = { email: null, emailVerified: false, name: null, nickname: null, avatar: null };

  it('answers invalid-response for an OAuthSetupError of the provider\'s own code, without throwing and without its text', async () => {
    const logger = recordingLogger();
    const { oauth, query } = await started({
      logger,
      overrides: {
        profile: async ({ tokens }) => {
          throw new OAuthSetupError('mine ' + tokens.accessToken);
        },
      },
    });
    expect(await oauth.callback('idp', query())).toEqual({ ok: false, error: { kind: 'invalid-response' } });
    expect(logger.entries.join('\n')).not.toContain('access-secret');
  });

  it('answers invalid-response when a getter of the mapUser answer throws, without throwing itself', async () => {
    const logger = recordingLogger();
    const { oauth, query } = await started({
      logger,
      overrides: {
        mapUser: () =>
          ({
            get id(): string {
              throw new Error('quotes access-secret');
            },
          }) as never,
      },
    });
    expect(await oauth.callback('idp', query())).toEqual({ ok: false, error: { kind: 'invalid-response' } });
    expect(logger.entries.join('\n')).not.toContain('access-secret');
  });

  it('cannot be made to turn the id into an object by a getter that answers differently the second time', async () => {
    let reads = 0;
    const { oauth, query } = await started({
      overrides: {
        mapUser: () =>
          ({
            ...user,
            get id() {
              reads += 1;
              return reads === 1 ? 'good' : { evil: true };
            },
          }) as never,
      },
    });
    const result = await oauth.callback('idp', query());
    expect(result.ok && result.value.user.id).toBe('good');
  });

  it('refuses an async mapUser, and takes its rejection so that none surfaces', async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => void unhandled.push(reason);
    process.on('unhandledRejection', listener);
    try {
      const { oauth, query } = await started({ overrides: { mapUser: (async () => Promise.reject(new Error('quotes access-secret'))) as never } });
      expect(await oauth.callback('idp', query())).toEqual({ ok: false, error: { kind: 'invalid-response' } });
      const resolved = await started({ overrides: { mapUser: (async () => ({ id: '1', ...user })) as never } });
      expect(await resolved.oauth.callback('idp', resolved.query())).toEqual({ ok: false, error: { kind: 'invalid-response' } });
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('unhandledRejection', listener);
    }
    expect(unhandled).toEqual([]);
  });

  it('logs a second tab, an expired flow and a person who said no at debug level, and the other refusals at warn', async () => {
    const logger = recordingLogger();
    const first = await started({ logger });
    await first.oauth.callback('idp', first.query());
    await first.oauth.callback('idp', first.query());
    const cancelled = await started({ logger });
    await cancelled.oauth.callback('idp', cancelled.query({ error: 'access_denied' }));
    const late = await started({ logger });
    late.clock.freeze(1_700_000_000_000 + 700_000);
    await late.oauth.callback('idp', late.query());
    const forged = await started({ logger });
    await forged.oauth.callback('idp', forged.query({ state: 'wrong' }));
    const levels = logger.entries.map((entry) => entry.split(' ')[0]);
    expect(logger.entries.filter((entry) => entry.startsWith('debug An OAuth callback was refused')).map((entry) => /"reason":"([^"]+)"/.exec(entry)![1])).toEqual(['no-flow', 'cancelled', 'expired']);
    expect(logger.entries.filter((entry) => entry.startsWith('warn')).map((entry) => /"reason":"([^"]+)"/.exec(entry)![1])).toEqual(['state']);
    expect(levels).not.toContain('error');
  });
});

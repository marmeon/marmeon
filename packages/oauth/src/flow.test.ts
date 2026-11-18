import { createHash } from 'node:crypto';
import { Session, type SessionConfig } from '@marmeon/session';
import { MemorySessionStore, plainSessionCodec } from '@marmeon/session/internal';
import { describe, expect, it } from 'vitest';
import { FLOW_SECONDS, flowKey, issueFlow, takeFlow, type OpenFlow } from './flow.ts';
import { fakeSession, oauthWith } from './test-helpers/flow.ts';

const flowOf = (session: { data: Map<string, unknown> }, name = 'idp'): OpenFlow => session.data.get(flowKey(name)) as OpenFlow;
const issue = (session: ReturnType<typeof fakeSession>, extra: Partial<Parameters<typeof issueFlow>[1]> = {}, provider = 'idp') =>
  issueFlow(session, { provider, intent: 'sign-in', scopes: ['profile'], pkce: true, nonce: false, nowSeconds: 1000, ...extra });

describe('issuing a flow', () => {
  it('issues a 256-bit state and verifier and an S256 challenge of the verifier', async () => {
    const { oauth, session } = oauthWith();
    const result = await oauth.redirect('idp');
    if (!result.ok) throw new Error('expected a URL');
    const flow = flowOf(session);
    for (const value of [flow.state, flow.verifier!]) {
      expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(value, 'base64url')).toHaveLength(32);
    }
    expect(flow.state).not.toBe(flow.verifier);
    expect(result.value.searchParams.get('code_challenge')).toBe(createHash('sha256').update(flow.verifier!).digest('base64url'));
    expect(result.value.searchParams.get('code_challenge_method')).toBe('S256');
    // The verifier itself never leaves the session.
    expect(result.value.href).not.toContain(flow.verifier!);
    // Two flows share nothing.
    await oauth.redirect('idp');
    expect(flowOf(session).state).not.toBe(flow.state);
    expect(flowOf(session).verifier).not.toBe(flow.verifier);
  });

  it('keeps one slot per provider: a second redirect replaces the first', async () => {
    const { oauth, session } = oauthWith();
    issue(session, {}, 'other');
    const other = flowOf(session, 'other');
    await oauth.redirect('idp', { intent: 'link' });
    const first = flowOf(session);
    await oauth.redirect('idp', { intent: 'reset' });
    expect([...session.data.keys()].sort()).toEqual(['_oauth_flow:idp', '_oauth_flow:other']);
    expect(flowOf(session)).toMatchObject({ intent: 'reset' });
    expect(flowOf(session).state).not.toBe(first.state);
    expect(flowOf(session, 'other')).toBe(other);
  });

  it('stores intent, user id and the issue time, and no nonce without nonce: true', async () => {
    const plain = oauthWith();
    await plain.oauth.redirect('idp');
    expect(flowOf(plain.session)).toMatchObject({ provider: 'idp', intent: 'sign-in', issuedAt: 1_700_000_000, until: 1_700_000_000 + FLOW_SECONDS });
    expect(Object.keys(flowOf(plain.session)).sort()).toEqual(['intent', 'issuedAt', 'provider', 'scopes', 'state', 'until', 'verifier']);
    const bound = oauthWith({ overrides: { nonce: true } });
    const result = await bound.oauth.redirect('idp', { intent: 'link', userId: 7 });
    const flow = flowOf(bound.session);
    expect(flow).toMatchObject({ intent: 'link', userId: 7 });
    expect(Buffer.from(flow.nonce!, 'base64url')).toHaveLength(32);
    expect(result.ok && result.value.searchParams.get('nonce')).toBe(flow.nonce);
    const without = await plain.oauth.redirect('idp');
    expect(without.ok && without.value.searchParams.has('nonce')).toBe(false);
  });

  it('refuses an intent that is no lower-case word', async () => {
    const { oauth, session } = oauthWith();
    for (const intent of ['', 'Sign-in', 'sign_in', '1st', '-x', 'a'.repeat(33), 'sign in', 'x\n', 5]) {
      await expect(oauth.redirect('idp', { intent } as never), String(intent)).rejects.toThrow(TypeError);
    }
    expect(session.data.size).toBe(0);
    for (const intent of ['sign-in', 'link', 'a', 'a'.repeat(32)]) expect((await oauth.redirect('idp', { intent })).ok, intent).toBe(true);
  });
});

describe('taking a flow', () => {
  it('hands the flow out once: the slot is emptied before anything is checked', () => {
    const session = fakeSession();
    const issued = issue(session);
    expect(takeFlow(session, 'idp', 1001)).toEqual({ ok: true, value: issued });
    expect(session.data.size).toBe(0);
    expect(takeFlow(session, 'idp', 1001)).toEqual({ ok: false, error: { kind: 'no-flow' } });
    // An expired flow is spent too.
    issue(session);
    expect(takeFlow(session, 'idp', 1000 + FLOW_SECONDS)).toEqual({ ok: false, error: { kind: 'expired' } });
    expect(session.data.size).toBe(0);
  });

  it('serves a flow for ten minutes and not a second longer', () => {
    const session = fakeSession();
    issue(session);
    expect(takeFlow(session, 'idp', 1000 + FLOW_SECONDS - 1).ok).toBe(true);
    issue(session);
    expect(takeFlow(session, 'idp', 1000 + FLOW_SECONDS)).toEqual({ ok: false, error: { kind: 'expired' } });
  });

  it('serves a provider only its own slot, and refuses a flow that names another provider', () => {
    const session = fakeSession();
    issue(session, {}, 'other');
    expect(takeFlow(session, 'idp', 1001)).toEqual({ ok: false, error: { kind: 'no-flow' } });
    // A flow that was moved into another provider's slot.
    session.data.set(flowKey('idp'), session.data.get(flowKey('other')));
    expect(takeFlow(session, 'idp', 1001)).toEqual({ ok: false, error: { kind: 'invalid' } });
  });

  it('refuses what is not a flow, and a session that is not started', () => {
    const valid = { provider: 'idp', state: 's', intent: 'sign-in', scopes: ['profile'], issuedAt: 1000, until: 1000 + FLOW_SECONDS };
    for (const value of ['text', 5, true, {}, { ...valid, state: '' }, { ...valid, state: 5 }, { ...valid, intent: 5 }, { ...valid, until: '1500' }, { ...valid, until: Number.NaN }, { ...valid, until: Number.POSITIVE_INFINITY }, { ...valid, until: 1e15 }, { ...valid, issuedAt: 1000.5 }, { ...valid, until: 1000 + FLOW_SECONDS + 1 }, { ...valid, until: 1000 + FLOW_SECONDS - 1 }, { ...valid, issuedAt: 1600, until: 1000 }, { ...valid, issuedAt: 9e15, until: 9e15 + FLOW_SECONDS }, { ...valid, issuedAt: 2000, until: 2000 + FLOW_SECONDS }, { ...valid, issuedAt: undefined }, { ...valid, verifier: 5 }, { ...valid, nonce: '' }, { ...valid, userId: {} }, { ...valid, scopes: undefined }, { ...valid, scopes: 'profile' }, { ...valid, scopes: [5] }, { ...valid, scopes: [''] }, { ...valid, scopes: Array.from({ length: 65 }, (_, i) => `s${i}`) }, { ...valid, scopes: ['x'.repeat(256)] }]) {
      const session = fakeSession();
      session.data.set(flowKey('idp'), value);
      expect(takeFlow(session, 'idp', 1001), JSON.stringify(value)).toEqual({ ok: false, error: { kind: 'invalid' } });
      // Spent all the same: a flow that fails a check cannot be tried again.
      expect(session.data.size).toBe(0);
    }
    const session = fakeSession();
    session.data.set(flowKey('idp'), valid);
    expect(takeFlow(session, 'idp', 1001).ok).toBe(true);
    const idle = fakeSession({ started: false });
    idle.data.set(flowKey('idp'), valid);
    expect(takeFlow(idle, 'idp', 1001)).toEqual({ ok: false, error: { kind: 'no-flow' } });
  });

  it('serves a flow of 64 scopes of 255 characters, the most the start and redirect() let through', () => {
    const scopes = Array.from({ length: 64 }, (_, i) => `${i}`.padEnd(255, 'x'));
    const session = fakeSession();
    session.data.set(flowKey('idp'), { provider: 'idp', state: 's', intent: 'sign-in', scopes, issuedAt: 1000, until: 1000 + FLOW_SECONDS });
    expect(takeFlow(session, 'idp', 1001).ok).toBe(true);
  });

  it('keeps only the fields of a flow', () => {
    const session = fakeSession();
    session.data.set(flowKey('idp'), { provider: 'idp', state: 's', intent: 'link', scopes: ['a'], issuedAt: 1000, until: 1600, userId: 'u', admin: true });
    const result = takeFlow(session, 'idp', 1001);
    expect(result).toEqual({ ok: true, value: { provider: 'idp', state: 's', intent: 'link', userId: 'u', scopes: ['a'], issuedAt: 1000, until: 1600 } });
  });
});

/** One request: start the session from `id`, run `use`, save. */
async function request<T>(store: MemorySessionStore, id: string | undefined, use: (session: Session) => T | Promise<T>): Promise<{ id: string; value: T }> {
  const session = new Session(store, { lifetimeMinutes: 120 } as SessionConfig, plainSessionCodec);
  await session.start(id);
  const value = await use(session);
  await session.save();
  return { id: session.id, value };
}

describe('the flow in a real session', () => {
  it('is the same flow in the next request that redirect() issued in the first', async () => {
    const store = new MemorySessionStore();
    const first = await request(store, undefined, async (session) => {
      const { oauth } = oauthWith({ session, overrides: { nonce: true } });
      await oauth.redirect('idp', { intent: 'link', userId: 7 });
      return session.get(flowKey('idp') as never) as unknown as OpenFlow;
    });
    expect(first.value).toMatchObject({ provider: 'idp', intent: 'link', userId: 7 });
    const second = await request(store, first.id, (session) => takeFlow(session, 'idp', 1_700_000_001));
    expect(second.value).toEqual({ ok: true, value: first.value });
    // Spent: the third request finds nothing.
    expect((await request(store, first.id, (session) => takeFlow(session, 'idp', 1_700_000_001))).value).toEqual({ ok: false, error: { kind: 'no-flow' } });
  });

  it('is not taken by a request that may not write the session, so it cannot serve twice', async () => {
    const store = new MemorySessionStore();
    const first = await request(store, undefined, (session) => void issue(session as never));
    const locked = async () =>
      (await request(store, first.id, (session) => {
        session.lock(() => false);
        return takeFlow(session, 'idp', 1001);
      })).value;
    expect(await locked()).toEqual({ ok: false, error: { kind: 'no-flow' } });
    expect(await locked()).toEqual({ ok: false, error: { kind: 'no-flow' } });
    // Left in the session for the request that may spend it, once.
    expect((await request(store, first.id, (session) => takeFlow(session, 'idp', 1001))).value.ok).toBe(true);
    expect((await request(store, first.id, (session) => takeFlow(session, 'idp', 1001))).value).toEqual({ ok: false, error: { kind: 'no-flow' } });
  });
});

describe('the time of a flow', () => {
  it('is over when the time of the check is no number', () => {
    const session = fakeSession();
    issue(session);
    expect(takeFlow(session, 'idp', Number.NaN)).toEqual({ ok: false, error: { kind: 'expired' } });
  });
});

import type { AuthUserId } from '@marmeon/auth';
import type { Connections } from '@marmeon/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SocialUser } from '../definition.ts';
import { markVerified } from '../verified.ts';
import { drivers, migratedConnections } from '../__fixtures__/databases.ts';
import { marked, UnboundFactors, world, type World, type WorldOptions } from '../test-helpers/social-accounts.ts';
import { SocialAccountLinked, SocialAccountUnlinked } from './events.ts';

describe.each(drivers)('SocialAccounts link and unlink on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  let w: World;
  const fresh = (options: WorldOptions = {}) => {
    w = world(connections, options);
    return w;
  };
  const providersOf = async (id: number) => (await w.store.forUser(id as AuthUserId)).map((record) => `${record.provider}:${record.providerId}`);
  const link = (id: string, provider = 'github', flowUserId = '1') => marked('link', { id, provider }, flowUserId);

  beforeAll(async () => {
    ({ connections, close } = await migratedConnections(driver));
  });
  afterAll(() => close());
  beforeEach(async () => {
    await connections.get<any>().deleteFrom('social_accounts').execute();
    await connections.get<any>().deleteFrom('users').execute();
    fresh();
  });

  it('links for a fresh confirmation only, checked here and not only in the middleware', async () => {
    w.signInAs(await w.add({ id: 1 }));
    w.state.confirmed = false;
    expect(await w.accounts.link(link('gh-1'))).toEqual({ ok: false, error: { kind: 'confirmation-required' } });
    expect(await providersOf(1)).toEqual([]);
    expect(w.state.events).toEqual([]);
    w.state.confirmed = true;
    const linked = await w.accounts.link(link('gh-1'));
    expect(linked).toMatchObject({ ok: true, value: { provider: 'github', email: 'ada@example.com', nickname: 'ada' } });
    expect(await providersOf(1)).toEqual(['github:gh-1']);
  });

  it('answers signed-out for nobody', async () => {
    await w.add({ id: 1 });
    expect(await w.accounts.link(link('gh-1'))).toEqual({ ok: false, error: { kind: 'signed-out' } });
    expect(await w.accounts.unlink('github')).toEqual({ ok: false, error: { kind: 'signed-out' } });
    expect(await w.accounts.list()).toEqual([]);
  });

  it('refuses a link result from a flow of another user', async () => {
    w.signInAs(await w.add({ id: 1 }));
    await w.add({ id: 2 });
    await expect(w.accounts.link(link('gh-1', 'github', '2'))).rejects.toThrow(TypeError);
    await expect(w.accounts.link(marked('link', { id: 'gh-1' }, undefined))).rejects.toThrow(TypeError);
    expect(await providersOf(1)).toEqual([]);
    expect(await providersOf(2)).toEqual([]);
  });

  it('never moves a provider account that belongs to another user', async () => {
    w.signInAs(await w.add({ id: 1 }));
    await w.add({ id: 2 });
    await w.store.create(2 as AuthUserId, marked('link', { id: 'gh-1' }, '2'));
    expect(await w.accounts.link(link('gh-1'))).toEqual({ ok: false, error: { kind: 'taken' } });
    expect(await providersOf(2)).toEqual(['github:gh-1']);
    expect(await providersOf(1)).toEqual([]);
    expect(w.state.events).toEqual([]);
  });

  it('links the same account of the same user again without a new link or event, and refreshes what the provider reports', async () => {
    w.signInAs(await w.add({ id: 1 }));
    w.clock.freeze(new Date('2030-01-01T00:00:00Z'));
    expect((await w.accounts.link(link('gh-1'))).ok).toBe(true);
    w.clock.freeze(new Date('2030-01-02T00:00:00Z'));
    const again = await w.accounts.link(marked('link', { id: 'gh-1', email: 'new@example.com', nickname: 'ada-new' }, '1'));
    expect(again).toMatchObject({ ok: true, value: { email: 'new@example.com', nickname: 'ada-new' } });
    expect(await providersOf(1)).toEqual(['github:gh-1']);
    expect(w.state.events).toHaveLength(1);
    expect((await w.store.find('github', 'gh-1'))?.lastUsedAt?.toISOString()).toBe('2030-01-02T00:00:00.000Z');
  });

  it('refuses a user whose address is not confirmed: a reset would strip the link, and a squatter could add one', async () => {
    w.signInAs(await w.add({ id: 1, emailVerified: false }));
    expect(await w.accounts.link(link('gh-1'))).toEqual({ ok: false, error: { kind: 'email-unconfirmed' } });
    expect(await providersOf(1)).toEqual([]);
    expect(w.state.events).toEqual([]);
  });

  it('counts an address as confirmed only when emailConfirmed answers exactly true', async () => {
    w.signInAs(await w.add({ id: 1 }));
    for (const answer of [new Date(), 1, 'yes']) {
      w.state.confirmedAnswer = answer;
      expect(await w.accounts.link(link('gh-1'))).toEqual({ ok: false, error: { kind: 'email-unconfirmed' } });
    }
    expect(await providersOf(1)).toEqual([]);
  });

  it('refuses a provider account that cannot be stored as invalid-account', async () => {
    w.signInAs(await w.add({ id: 1 }));
    expect(await w.accounts.link(link('a'.repeat(256)))).toEqual({ ok: false, error: { kind: 'invalid-account' } });
    expect(await w.accounts.link(link('gh-\ud800'))).toEqual({ ok: false, error: { kind: 'invalid-account' } });
    expect(await w.accounts.link(marked('link', { id: 'gh-1', email: 'a@example.com\r\nBcc: x' }, '1'))).toEqual({ ok: false, error: { kind: 'invalid-account' } });
    expect(await providersOf(1)).toEqual([]);
  });

  it('reads the profile once: an accessor cannot link another provider id than the one the checks saw', async () => {
    w.signInAs(await w.add({ id: 1 }));
    let reads = 0;
    const accessors = {
      provider: 'github',
      email: 'ada@example.com',
      emailVerified: true,
      name: null,
      nickname: null,
      avatar: null,
      raw: {},
      tokens: { accessToken: 'x', scopes: [] as string[] },
      get id() {
        return reads++ === 0 ? 'gh-1' : 'gh-other';
      },
    } as SocialUser;
    markVerified(accessors, { intent: 'link', flowUserId: '1' });
    expect((await w.accounts.link(accessors)).ok).toBe(true);
    expect(await providersOf(1)).toEqual(['github:gh-1']);
  });

  it('refuses to link an account that was unlinked after it was found', async () => {
    w.signInAs(await w.add({ id: 1 }));
    await w.accounts.link(link('gh-1'));
    vi.spyOn(w.store, 'touch').mockResolvedValue(false);
    expect(await w.accounts.link(link('gh-1'))).toEqual({ ok: false, error: { kind: 'taken' } });
  });

  it('refuses a second account of a provider', async () => {
    w.signInAs(await w.add({ id: 1 }));
    await w.accounts.link(link('gh-1'));
    expect(await w.accounts.link(link('gh-2'))).toEqual({ ok: false, error: { kind: 'provider-linked' } });
    expect(await providersOf(1)).toEqual(['github:gh-1']);
  });

  it('lists the accounts of the signed-in user with the label of an active provider', async () => {
    fresh({ active: ['github'] });
    w.signInAs(await w.add({ id: 1 }));
    await w.accounts.link(link('gh-1'));
    await w.accounts.link(link('gl-1', 'gitlab'));
    const list = await w.accounts.list();
    expect(list.map((entry) => [entry.provider, entry.label])).toEqual([
      ['github', 'GITHUB'],
      ['gitlab', 'gitlab'],
    ]);
  });

  it('unlinks while a password remains', async () => {
    w.signInAs(await w.add({ id: 1, passwordHash: 'hash' }));
    await w.accounts.link(link('gh-1'));
    expect(await w.accounts.unlink('github')).toEqual({ ok: true, value: undefined });
    expect(await providersOf(1)).toEqual([]);
  });

  it('unlinks while a passkey remains', async () => {
    w.signInAs(await w.add({ id: 1, passwordHash: null }));
    w.factors.factorsOf.set(1, ['passkey']);
    await w.accounts.link(link('gh-1'));
    expect((await w.accounts.unlink('github')).ok).toBe(true);
    expect(await providersOf(1)).toEqual([]);
  });

  it('refuses to unlink the last way in', async () => {
    w.signInAs(await w.add({ id: 1, passwordHash: null }));
    w.factors.factorsOf.set(1, ['totp']);
    await w.accounts.link(link('gh-1'));
    expect(await w.accounts.unlink('github')).toEqual({ ok: false, error: { kind: 'last-method' } });
    expect(await providersOf(1)).toEqual(['github:gh-1']);
    expect(w.state.events.filter((event) => event instanceof SocialAccountUnlinked)).toEqual([]);
  });

  it('does not count a passkey when TwoFactorState is not bound', async () => {
    fresh({ factors: new UnboundFactors() });
    w.signInAs(await w.add({ id: 1, passwordHash: null }));
    await w.accounts.link(link('gh-1'));
    expect(await w.accounts.unlink('github')).toEqual({ ok: false, error: { kind: 'last-method' } });
    expect(await providersOf(1)).toEqual(['github:gh-1']);
  });

  it('counts a remaining account at an active provider as a way in, and one at a provider that is not active as none', async () => {
    fresh({ active: ['gitlab'] });
    w.signInAs(await w.add({ id: 1, passwordHash: null }));
    await w.accounts.link(link('gh-1'));
    await w.accounts.link(link('gl-1', 'gitlab'));
    expect((await w.accounts.unlink('github')).ok).toBe(true);
    expect(await w.accounts.unlink('gitlab')).toEqual({ ok: false, error: { kind: 'last-method' } });

    fresh({ active: [] });
    w.signInAs(await w.add({ id: 2, passwordHash: null }));
    await w.accounts.link(link('gh-2', 'github', '2'));
    await w.accounts.link(link('gl-2', 'gitlab', '2'));
    expect(await w.accounts.unlink('github')).toEqual({ ok: false, error: { kind: 'last-method' } });
  });

  it('answers not-found for a provider the user has no account at, and needs a fresh confirmation to unlink', async () => {
    w.signInAs(await w.add({ id: 1 }));
    await w.accounts.link(link('gh-1'));
    expect(await w.accounts.unlink('gitlab')).toEqual({ ok: false, error: { kind: 'not-found' } });
    w.state.confirmed = false;
    expect(await w.accounts.unlink('github')).toEqual({ ok: false, error: { kind: 'confirmation-required' } });
    expect(await providersOf(1)).toEqual(['github:gh-1']);
  });

  it('dispatches SocialAccountLinked and SocialAccountUnlinked after the change only', async () => {
    const ada = await w.add({ id: 1 });
    w.signInAs(ada);
    await w.accounts.link(link('gh-1'));
    expect(w.state.events).toHaveLength(1);
    expect(w.state.events[0]).toBeInstanceOf(SocialAccountLinked);
    expect(w.state.events[0]).toMatchObject({ user: ada, provider: 'github', email: 'ada@example.com', nickname: 'ada' });
    // The account was stored when the event went out.
    expect(w.state.heldAtEvent).toEqual([true]);

    await w.accounts.unlink('github');
    expect(w.state.events[1]).toBeInstanceOf(SocialAccountUnlinked);
    expect(w.state.events[1]).toMatchObject({ user: ada, provider: 'github' });
    // And gone when the unlink event went out.
    expect(w.state.heldAtEvent[1]).toBe(false);
    // A refusal dispatches nothing.
    await w.accounts.unlink('github');
    expect(w.state.events).toHaveLength(2);
  });
});

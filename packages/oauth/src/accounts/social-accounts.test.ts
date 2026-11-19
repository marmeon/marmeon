import { Registered, type AuthUserId } from '@marmeon/auth';
import type { Connections } from '@marmeon/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { drivers, migratedConnections } from '../__fixtures__/databases.ts';
import { OAuthSetupError } from '../config.ts';
import type { SocialUser } from '../definition.ts';
import { idOf, marked, world, type World, type WorldOptions } from '../test-helpers/social-accounts.ts';
import { markVerified, verifiedInfo } from '../verified.ts';
import { SocialAccountLinked } from './events.ts';

describe.each(drivers)('SocialAccounts sign-in on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  let w: World;
  const fresh = (options: WorldOptions = {}) => {
    w = world(connections, options);
    return w;
  };
  const accountsOf = async (id: number) => (await w.store.forUser(id as AuthUserId)).map((record) => `${record.provider}:${record.providerId}`);

  beforeAll(async () => {
    ({ connections, close } = await migratedConnections(driver));
  });
  afterAll(() => close());
  beforeEach(async () => {
    await connections.get<any>().deleteFrom('social_accounts').execute();
    await connections.get<any>().deleteFrom('users').execute();
    fresh();
  });

  it('signs in the owner of a known provider account (rule 1)', async () => {
    const ada = await w.add({ id: 1, email: 'other@example.com', emailVerified: false });
    await w.store.create(1 as AuthUserId, marked('sign-in', { email: 'moved@example.com', emailVerified: false }));
    const result = await w.accounts.signIn(marked('sign-in', { email: 'moved@example.com', emailVerified: false }));
    expect(result).toEqual({ ok: true, value: { kind: 'signed-in', user: ada, created: false } });
    expect(w.state.signedIn).toBe(ada);
    expect((await w.store.find('github', 'gh-1'))?.lastUsedAt).toBeInstanceOf(Date);
  });

  it('hands two-factor-required on for a linked account with a second factor', async () => {
    await w.add({ id: 1 });
    w.factors.factorsOf.set(1, ['totp']);
    await w.store.create(1 as AuthUserId, marked('sign-in'));
    expect(await w.accounts.signIn(marked('sign-in'))).toEqual({ ok: true, value: { kind: 'two-factor-required' } });
    expect(w.state.signedIn).toBeUndefined();
  });

  it('refuses to sign in an account that was unlinked after it was found, and signs nobody in', async () => {
    await w.add({ id: 1 });
    await w.store.create(1 as AuthUserId, marked('sign-in'));
    vi.spyOn(w.store, 'touch').mockResolvedValue(false);
    const result = await w.accounts.signIn(marked('sign-in'));
    expect(result.ok).toBe(false);
    expect(w.state.signedIn).toBeUndefined();
    expect(w.state.signIns).toEqual([]);
  });

  it('links and signs in when both addresses are verified and no second factor is set (rule 2)', async () => {
    const ada = await w.add({ id: 1, email: 'ada@example.com', emailVerified: true });
    const result = await w.accounts.signIn(marked('sign-in'));
    expect(result).toEqual({ ok: true, value: { kind: 'signed-in', user: ada, created: false } });
    expect(await accountsOf(1)).toEqual(['github:gh-1']);
    expect(w.state.signedIn).toBe(ada);
    expect(w.state.events[0]).toBeInstanceOf(SocialAccountLinked);
  });

  it("refuses to link when the provider's address is unverified", async () => {
    // Open registration: with private registration the unverified address is refused before any user is looked up.
    fresh({ privateRegistration: false });
    await w.add({ id: 1, email: 'ada@example.com', emailVerified: true });
    const result = await w.accounts.signIn(marked('sign-in', { emailVerified: false }));
    expect(result).toEqual({ ok: false, error: { kind: 'account-exists', providerVerified: false } });
    expect(await accountsOf(1)).toEqual([]);
    expect(w.state.signedIn).toBeUndefined();
    expect(w.state.events).toEqual([]);
  });

  it('refuses to link when the local address is unverified', async () => {
    await w.add({ id: 1, email: 'ada@example.com', emailVerified: false });
    const result = await w.accounts.signIn(marked('sign-in'));
    expect(result).toEqual({ ok: false, error: { kind: 'account-exists', providerVerified: true } });
    expect(await accountsOf(1)).toEqual([]);
    expect(w.state.signedIn).toBeUndefined();
  });

  it('refuses to link an account with a second factor: sign in first, then link', async () => {
    await w.add({ id: 1, email: 'ada@example.com', emailVerified: true });
    w.factors.factorsOf.set(1, ['passkey']);
    const result = await w.accounts.signIn(marked('sign-in'));
    expect(result).toEqual({ ok: false, error: { kind: 'account-exists', providerVerified: true } });
    expect(await accountsOf(1)).toEqual([]);
    expect(w.state.signedIn).toBeUndefined();
    expect(w.state.signIns).toEqual([]);
  });

  it('registers through SocialUserProvider.create, links, and signs in a verified address (rule 3)', async () => {
    const result = await w.accounts.signIn(marked('sign-in'));
    if (!result.ok || result.value.kind !== 'signed-in') throw new Error(JSON.stringify(result));
    expect(result.value.created).toBe(true);
    expect(w.state.createCalls).toBe(1);
    expect(await accountsOf(idOf(result.value.user))).toEqual(['github:gh-1']);
    expect(w.state.signedIn).toBe(result.value.user);
    // The app's `Registered` goes out in the transaction after the link, `SocialAccountLinked` after the commit.
    expect(w.state.events.map((event) => event.constructor)).toEqual([Registered, SocialAccountLinked]);
    // `Registered` inside the transaction that made the user, `SocialAccountLinked` only after it committed.
    expect(w.state.inTransaction).toEqual([true, false]);
    expect(w.state.heldAtEvent[1]).toBe(true);
  });

  it('stores the new address as confirmed only when the provider verified it', async () => {
    // Open registration signs both in, so the user each registration made is the one `auth.signIn` saw.
    fresh({ privateRegistration: false });
    await w.accounts.signIn(marked('sign-in', { id: 'v', email: 'v@example.com', emailVerified: true }));
    w.state.signedIn = undefined;
    await w.accounts.signIn(marked('sign-in', { id: 'u', email: 'u@example.com', emailVerified: false }));
    const made = (email: string) => w.state.signIns.find((user) => user.email === email);
    expect(made('v@example.com')?.emailVerified).toBe(true);
    expect(made('u@example.com')?.emailVerified).toBe(false);
  });

  it('with private registration and an unverified address: answers email-unverified for a known and an unknown address alike, and writes nothing', async () => {
    await w.add({ id: 1, email: 'ada@example.com', emailVerified: true });
    const known = await w.accounts.signIn(marked('sign-in', { emailVerified: false }));
    const unknown = await w.accounts.signIn(marked('sign-in', { id: 'gh-2', email: 'nobody@example.com', emailVerified: false }));
    expect(known).toEqual({ ok: false, error: { kind: 'email-unverified' } });
    expect(unknown).toEqual(known);
    expect(await accountsOf(1)).toEqual([]);
    expect(await w.store.find('github', 'gh-2')).toBeUndefined();
    expect(await w.userCount()).toBe(1);
    expect(w.state.createCalls).toBe(0);
    expect(w.state.signedIn).toBeUndefined();
    expect(w.state.events).toEqual([]);
    // The second click is the same answer: nothing was made that could sign anybody in.
    expect(await w.accounts.signIn(marked('sign-in', { id: 'gh-2', email: 'nobody@example.com', emailVerified: false }))).toEqual(known);
    expect(w.state.signIns).toEqual([]);
  });

  it('still signs in an account that is linked already when the provider reports an unverified address (rule 1)', async () => {
    await w.add({ id: 1 });
    await w.store.create(1 as AuthUserId, marked('sign-in'));
    expect((await w.accounts.signIn(marked('sign-in', { emailVerified: false }))).ok).toBe(true);
  });

  it('counts an address as verified only when the provider sent exactly true', async () => {
    for (const emailVerified of ['false', 1, 'true', undefined]) {
      const odd = marked('sign-in', { id: `odd-${String(emailVerified)}`, emailVerified: emailVerified as never });
      expect(verifiedInfo(odd)?.subject.emailVerified).toBe(false);
    }
    // With private registration it is the unverified answer; with a local user that has the address, rule 2 does not link.
    expect(await w.accounts.signIn(marked('sign-in', { emailVerified: 'false' as never }))).toEqual({ ok: false, error: { kind: 'email-unverified' } });
    fresh({ privateRegistration: false });
    await w.add({ id: 1, email: 'ada@example.com', emailVerified: true });
    expect(await w.accounts.signIn(marked('sign-in', { emailVerified: 1 as never }))).toEqual({ ok: false, error: { kind: 'account-exists', providerVerified: false } });
    expect(await accountsOf(1)).toEqual([]);
    // A new user from such a profile is stored as unconfirmed.
    w.state.signedIn = undefined;
    await w.accounts.signIn(marked('sign-in', { id: 'one', email: 'one@example.com', emailVerified: 1 as never }));
    expect(w.state.signIns.find((user) => user.email === 'one@example.com')?.emailVerified).toBe(false);
  });

  it('with open registration and an unverified address: registers and signs in', async () => {
    fresh({ privateRegistration: false });
    const result = await w.accounts.signIn(marked('sign-in', { emailVerified: false }));
    if (!result.ok || result.value.kind !== 'signed-in') throw new Error(JSON.stringify(result));
    expect(result.value.created).toBe(true);
    expect(w.state.signedIn).toBe(result.value.user);
    expect(w.state.events.map((event) => event.constructor)).toEqual([Registered, SocialAccountLinked]);
  });

  it('answers registration-closed with OAUTH_REGISTRATION=false and creates nothing', async () => {
    fresh({ registration: false });
    expect(await w.accounts.signIn(marked('sign-in'))).toEqual({ ok: false, error: { kind: 'registration-closed' } });
    expect(w.state.createCalls).toBe(0);
    expect(await w.userCount()).toBe(0);
    expect(w.state.signedIn).toBeUndefined();
  });

  it('still signs in a linked account and links a verified address with OAUTH_REGISTRATION=false', async () => {
    fresh({ registration: false });
    await w.add({ id: 1 });
    await w.store.create(1 as AuthUserId, marked('sign-in', { id: 'old' }));
    expect((await w.accounts.signIn(marked('sign-in', { id: 'old' }))).ok).toBe(true);
  });

  it('answers email-required for a profile without an address', async () => {
    expect(await w.accounts.signIn(marked('sign-in', { email: null }))).toEqual({ ok: false, error: { kind: 'email-required' } });
    expect(w.state.createCalls).toBe(0);
  });

  it('answers account-exists and rolls the new user back when the provider account is linked elsewhere during the registration', async () => {
    await w.add({ id: 2, email: 'two@example.com' });
    // The register transaction makes the user first; the provider account is then taken by another user before the link is written.
    const original = w.store.create.bind(w.store);
    vi.spyOn(w.store, 'create').mockImplementationOnce(async (userId, social: SocialUser) => {
      await original(2 as AuthUserId, marked('sign-in', { id: social.id, email: 'x@example.com' }));
      return original(userId, social);
    });
    const raced = await w.accounts.signIn(marked('sign-in', { email: 'new@example.com' }));
    expect(raced).toEqual({ ok: false, error: { kind: 'account-exists', providerVerified: true } });
    expect(w.state.createCalls).toBe(1);
    expect(await w.userCount()).toBe(1);
    expect(w.state.events).toEqual([]);
    expect(w.state.signedIn).toBeUndefined();
  });

  it('answers account-exists when SocialUserProvider.create reports a duplicate', async () => {
    w.state.duplicate = true;
    expect(await w.accounts.signIn(marked('sign-in'))).toEqual({ ok: false, error: { kind: 'account-exists', providerVerified: true } });
    expect(w.state.signedIn).toBeUndefined();
  });

  it('answers account-exists when linking a matching address fails as taken and the account is gone again', async () => {
    await w.add({ id: 1, email: 'ada@example.com' });
    vi.spyOn(w.store, 'create').mockResolvedValueOnce({ ok: false, error: { kind: 'taken' } });
    expect(await w.accounts.signIn(marked('sign-in'))).toEqual({ ok: false, error: { kind: 'account-exists', providerVerified: true } });
    expect(w.state.signedIn).toBeUndefined();
    expect(w.state.events).toEqual([]);
  });

  it('treats an answer of null from findByEmail like no user', async () => {
    await w.add({ id: 1, email: 'ada@example.com' });
    w.state.lookupNull = true;
    const result = await w.accounts.signIn(marked('sign-in'));
    if (!result.ok || result.value.kind !== 'signed-in') throw new Error(JSON.stringify(result));
    expect(result.value.created).toBe(true);
    expect(await accountsOf(1)).toEqual([]);
  });

  it('treats an account linked between lookup and insert as rule 1', async () => {
    await w.add({ id: 1, email: 'ada@example.com' });
    await w.add({ id: 2, email: 'two@example.com' });
    w.state.afterLookup = async () => {
      await w.store.create(2 as AuthUserId, marked('sign-in'));
    };
    const result = await w.accounts.signIn(marked('sign-in'));
    if (!result.ok || result.value.kind !== 'signed-in') throw new Error(JSON.stringify(result));
    expect(idOf(result.value.user)).toBe(2);
    expect(await accountsOf(1)).toEqual([]);
  });

  it('answers account-exists when the user has an account at the provider already', async () => {
    await w.add({ id: 1, email: 'ada@example.com' });
    await w.store.create(1 as AuthUserId, marked('sign-in', { id: 'other-gh' }));
    expect(await w.accounts.signIn(marked('sign-in'))).toEqual({ ok: false, error: { kind: 'account-exists', providerVerified: true } });
    expect(w.state.signedIn).toBeUndefined();
  });

  it('refuses signIn while somebody is signed in', async () => {
    const ada = await w.add({ id: 1 });
    w.signInAs(ada);
    await w.store.create(1 as AuthUserId, marked('sign-in'));
    expect(await w.accounts.signIn(marked('sign-in'))).toEqual({ ok: false, error: { kind: 'signed-in' } });
    expect(w.state.signIns).toEqual([]);
    expect((await w.store.find('github', 'gh-1'))?.lastUsedAt).toBeInstanceOf(Date);
  });

  it('refuses a SocialUser that callback() did not return, and one returned for another intent', async () => {
    await w.add({ id: 1 });
    await w.store.create(1 as AuthUserId, marked('sign-in'));
    const built = { ...marked('sign-in') };
    await expect(w.accounts.signIn(built)).rejects.toThrow(TypeError);
    await expect(w.accounts.signIn(marked('link', {}, '1'))).rejects.toThrow(TypeError);
    await expect(w.accounts.link(marked('sign-in'))).rejects.toThrow(TypeError);
    expect(w.state.signIns).toEqual([]);
  });

  it('refuses provider data the table cannot hold as invalid-account, never a throw', async () => {
    await w.add({ id: 1 });
    const bad: Partial<SocialUser>[] = [
      { id: 'a'.repeat(256) },
      { id: 'a\0b' },
      { id: '   ' },
      { id: '\u0007' },
      // A lone surrogate is stored as another text, so two different ids would meet.
      { id: 'gh-\ud800' },
      { email: 'a\0@example.com' },
      { email: 'ada@example.com\r\nBcc: boss@example.com' },
      { email: `${'a'.repeat(243)}@example.com` },
      { email: 'ada\ud800@example.com' },
      { nickname: 'n\0' },
      { nickname: 'n\udc00' },
    ];
    for (const overrides of bad) {
      expect(await w.accounts.signIn(marked('sign-in', overrides)), JSON.stringify(overrides)).toEqual({ ok: false, error: { kind: 'invalid-account' } });
    }
    // The longest address and id still pass.
    expect((await w.accounts.signIn(marked('sign-in', { id: 'a'.repeat(255), email: `${'a'.repeat(242)}@example.com` }))).ok).toBe(true);
    expect(w.state.createCalls).toBe(1);
  });

  it('signs in a linked account whose profile has no address', async () => {
    await w.add({ id: 1 });
    await w.store.create(1 as AuthUserId, marked('sign-in'));
    const result = await w.accounts.signIn(marked('sign-in', { email: null }));
    expect(result.ok && result.value.kind).toBe('signed-in');
  });

  it('refuses the sign-in of a linked account whose user is gone, and signs nobody in', async () => {
    await w.add({ id: 1 });
    await w.store.create(1 as AuthUserId, marked('sign-in'));
    w.state.noUsers = true;
    expect(await w.accounts.signIn(marked('sign-in'))).toEqual({ ok: false, error: { kind: 'account-exists', providerVerified: true } });
    expect(w.state.signIns).toEqual([]);
  });

  it('notes the time of each sign-in, and leaves the row alone when it refuses one', async () => {
    await w.add({ id: 1 });
    w.clock.freeze(new Date('2030-01-01T00:00:00Z'));
    await w.store.create(1 as AuthUserId, marked('sign-in'));
    w.clock.freeze(new Date('2030-01-02T00:00:00Z'));
    await w.accounts.signIn(marked('sign-in', { nickname: 'ada2' }));
    const signedIn = await w.store.find('github', 'gh-1');
    expect(signedIn?.lastUsedAt?.toISOString()).toBe('2030-01-02T00:00:00.000Z');
    expect(signedIn?.nickname).toBe('ada2');
    w.clock.freeze(new Date('2030-01-03T00:00:00Z'));
    await w.accounts.signIn(marked('sign-in', { nickname: 'ada3' }));
    expect((await w.store.find('github', 'gh-1'))?.lastUsedAt?.toISOString()).toBe('2030-01-02T00:00:00.000Z');
  });

  it('signs the user out again when the link is gone once they are signed in', async () => {
    await w.add({ id: 1 });
    await w.store.create(1 as AuthUserId, marked('sign-in'));
    // Deleted after `touch`, while `auth.signIn` runs.
    w.state.afterAuthSignIn = async () => void (await w.store.removeAll(1 as AuthUserId));
    expect(await w.accounts.signIn(marked('sign-in'))).toEqual({ ok: false, error: { kind: 'account-exists', providerVerified: true } });
    expect(w.state.signedIn).toBeUndefined();
  });

  it('signs the user out again when the link was moved to another user while they were signed in', async () => {
    await w.add({ id: 1 });
    await w.add({ id: 2 });
    await w.store.create(1 as AuthUserId, marked('sign-in'));
    // Deleted and made again for another user, after `touch`, while `auth.signIn` runs.
    w.state.afterAuthSignIn = async () => {
      await w.store.removeAll(1 as AuthUserId);
      await w.store.create(2 as AuthUserId, marked('sign-in'));
    };
    expect(await w.accounts.signIn(marked('sign-in'))).toEqual({ ok: false, error: { kind: 'account-exists', providerVerified: true } });
    expect(w.state.signedIn).toBeUndefined();
  });

  it('drops a waiting second-factor sign-in when the link is gone by then', async () => {
    await w.add({ id: 1 });
    w.factors.factorsOf.set(1, ['totp']);
    await w.store.create(1 as AuthUserId, marked('sign-in'));
    w.state.afterAuthSignIn = async () => void (await w.store.removeAll(1 as AuthUserId));
    expect(await w.accounts.signIn(marked('sign-in'))).toEqual({ ok: false, error: { kind: 'account-exists', providerVerified: true } });
    expect(w.state.pending).toBeUndefined();
    expect(w.state.signedIn).toBeUndefined();
  });

  it('signs the user out again when the link vanished between its insert and the sign-in (rule 2)', async () => {
    await w.add({ id: 1, email: 'ada@example.com', emailVerified: true });
    w.state.afterAuthSignIn = async () => void (await w.store.removeAll(1 as AuthUserId));
    expect(await w.accounts.signIn(marked('sign-in'))).toEqual({ ok: false, error: { kind: 'account-exists', providerVerified: true } });
    expect(w.state.signedIn).toBeUndefined();
    expect(await accountsOf(1)).toEqual([]);
    // The link existed when the event went out.
    expect(w.state.events.length).toBe(1);
  });

  it('signs the user out again when the link vanished between the registration and the sign-in (rule 3)', async () => {
    w.state.afterAuthSignIn = async () => void (await connections.get<any>().deleteFrom('social_accounts').execute());
    expect(await w.accounts.signIn(marked('sign-in'))).toEqual({ ok: false, error: { kind: 'account-exists', providerVerified: true } });
    expect(w.state.signedIn).toBeUndefined();
  });

  it('drops a waiting second-factor sign-in when the link of a registration is gone by then', async () => {
    // Rule 3 asks for factors only at the sign-in: the user the registration made has a second factor.
    vi.spyOn(w.factors, 'factors').mockResolvedValue(['totp']);
    w.state.afterAuthSignIn = async () => void (await connections.get<any>().deleteFrom('social_accounts').execute());
    const made = await w.accounts.signIn(marked('sign-in'));
    expect(made).toEqual({ ok: false, error: { kind: 'account-exists', providerVerified: true } });
    expect(w.state.pending).toBeUndefined();
    expect(w.state.signedIn).toBeUndefined();
  });

  it('refuses a rule 2 link whose address changed hands after the lookup: no row, no event, nobody signed in', async () => {
    await w.add({ id: 1, email: 'ada@example.com', emailVerified: true });
    const other = await w.add({ id: 2, email: 'two@example.com', emailVerified: true });
    const cases: ((answer: { user: any; emailVerified: boolean } | undefined) => { user: any; emailVerified: boolean } | undefined)[] = [
      () => undefined, // the address is gone
      () => ({ user: other, emailVerified: true }), // another user has it now
      (answer) => answer && { ...answer, emailVerified: false }, // verification lost
      () => null as never, // a provider that answers loosely
    ];
    for (const relookup of cases) {
      w.state.lookups = 0;
      w.state.relookup = relookup;
      expect(await w.accounts.signIn(marked('sign-in'))).toEqual({ ok: false, error: { kind: 'account-exists', providerVerified: true } });
      expect(await accountsOf(1)).toEqual([]);
      expect(await w.store.find('github', 'gh-1')).toBeUndefined();
      expect(w.state.events).toEqual([]);
      expect(w.state.signedIn).toBeUndefined();
      expect(w.state.signIns).toEqual([]);
    }
  });

  it('rolls the link back when the second lookup of the address throws: no row, no event, nobody signed in', async () => {
    await w.add({ id: 1, email: 'ada@example.com', emailVerified: true });
    w.state.relookup = () => {
      throw new Error('lookup broke');
    };
    await expect(w.accounts.signIn(marked('sign-in'))).rejects.toThrow('lookup broke');
    expect(await w.store.find('github', 'gh-1')).toBeUndefined();
    expect(w.state.events).toEqual([]);
    expect(w.state.signedIn).toBeUndefined();
    expect(w.state.signIns).toEqual([]);
  });

  it('writes the link and looks the address up again in one transaction, and a refusal leaves no row a later sign-in could use', async () => {
    // A second request cannot be run beside the transaction on sqlite's single writer; what is proved here is the transaction itself:
    // the second lookup runs inside it (so the row is not committed before the check), and its rollback leaves nothing behind.
    await w.add({ id: 1, email: 'ada@example.com', emailVerified: true });
    w.state.relookup = (answer) => answer && { ...answer, emailVerified: false };
    expect(await w.accounts.signIn(marked('sign-in'))).toEqual({ ok: false, error: { kind: 'account-exists', providerVerified: true } });
    expect(w.state.lookupInTransaction).toEqual([false, true]);
    w.state.lookups = 0;
    expect(await w.accounts.signIn(marked('sign-in'))).toEqual({ ok: false, error: { kind: 'account-exists', providerVerified: true } });
    expect(w.state.signedIn).toBeUndefined();
    expect(await w.store.find('github', 'gh-1')).toBeUndefined();
  });

  it('signs nobody in when the lookup of the link after the sign-in throws, and keeps no waiting second factor', async () => {
    await w.add({ id: 1 });
    w.factors.factorsOf.set(1, ['totp']);
    await w.store.create(1 as AuthUserId, marked('sign-in'));
    const find = w.store.find.bind(w.store);
    vi.spyOn(w.store, 'find').mockImplementation(async (provider, id) => {
      // The first lookup finds the account; the one after `auth.signIn` breaks.
      if (w.state.signIns.length > 0) throw new Error('find broke');
      return find(provider, id);
    });
    await expect(w.accounts.signIn(marked('sign-in'))).rejects.toThrow('find broke');
    expect(w.state.signedIn).toBeUndefined();
    expect(w.state.pending).toBeUndefined();
  });

  it('signs out and rethrows the original error when auth.signIn throws after it wrote the session, a waiting second factor included', async () => {
    await w.add({ id: 1 });
    await w.store.create(1 as AuthUserId, marked('sign-in'));
    // The session is written first and something throws after it (unreachable with today's Auth, which takes its own failures back).
    w.state.afterAuthSignIn = async () => {
      throw new Error('listener broke');
    };
    await expect(w.accounts.signIn(marked('sign-in'))).rejects.toThrow('listener broke');
    expect(w.state.signedIn).toBeUndefined();
    w.factors.factorsOf.set(1, ['totp']);
    await expect(w.accounts.signIn(marked('sign-in'))).rejects.toThrow('listener broke');
    expect(w.state.signedIn).toBeUndefined();
    expect(w.state.pending).toBeUndefined();
    // The link gone by then changes nothing: any throw signs out.
    w.state.afterAuthSignIn = async () => {
      await w.store.removeAll(1 as AuthUserId);
      throw new Error('listener broke');
    };
    await expect(w.accounts.signIn(marked('sign-in'))).rejects.toThrow('listener broke');
    expect(w.state.signedIn).toBeUndefined();
  });

  it('reads the profile once: an accessor on the object cannot show the store another identity than the checks saw', async () => {
    await w.add({ id: 1 });
    await w.store.create(1 as AuthUserId, marked('sign-in'));
    const calls = { id: 0, nickname: 0 };
    // The accessor object, as a callback with a getter would have built it, marked as the flow does.
    const accessors = {
      provider: 'github',
      email: 'ada@example.com',
      emailVerified: true,
      name: 'Ada',
      avatar: null,
      raw: {},
      tokens: { accessToken: 'x', scopes: [] as string[] },
      get id() {
        return calls.id++ === 0 ? 'gh-1' : 'gh-other';
      },
      get nickname() {
        return calls.nickname++ < 2 ? 'ada' : 'n\0';
      },
    } as SocialUser;
    markVerified(accessors, { intent: 'sign-in', flowUserId: undefined });
    const result = await w.accounts.signIn(accessors);
    expect(result.ok && result.value.kind).toBe('signed-in');
    expect((await w.store.find('github', 'gh-1'))?.nickname).toBe('ada');
    expect(await w.store.find('github', 'gh-other')).toBeUndefined();
  });

  it('explains a missing SocialUserProvider (A10) when a user is to be found or made, and lets a bound one fail with its own error', async () => {
    w.state.boundSocialUsers = false;
    await expect(w.accounts.signIn(marked('sign-in'))).rejects.toThrow(OAuthSetupError);
    await expect(w.accounts.signIn(marked('sign-in'))).rejects.toThrow(/SocialUserProvider is not bound/);
    // A linked account needs no SocialUserProvider.
    await w.add({ id: 1 });
    await w.store.create(1 as AuthUserId, marked('sign-in', { id: 'known' }));
    expect((await w.accounts.signIn(marked('sign-in', { id: 'known' }))).ok).toBe(true);
    w.state.signedIn = undefined;
    w.state.boundSocialUsers = true;
    w.state.buildFails = true;
    const failure = await w.accounts.signIn(marked('sign-in', { id: 'other', email: 'x@example.com' })).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(OAuthSetupError);
    expect((failure as Error).message).toBe('UserRepository needs a table');
  });
});

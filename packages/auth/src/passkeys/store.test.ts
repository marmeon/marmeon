import { SystemClock, type Clock } from '@marmeon/core';
import type { Connections } from '@marmeon/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drivers, migratedConnections } from '../__fixtures__/databases.ts';
import { combineFactors } from '../two-factor/state.ts';
import { RECOVERY_CODES_TABLE, TWO_FACTOR_TABLE, TwoFactorStore } from '../two-factor/store.ts';
import { PASSKEYS_TABLE, PasskeyStore, type NewPasskey } from './store.ts';

describe.each(drivers)('PasskeyStore on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  let store: PasskeyStore;

  beforeAll(async () => {
    ({ connections, close } = await migratedConnections(driver));
    store = new PasskeyStore(connections, new SystemClock());
  });
  afterAll(() => close());
  beforeEach(async () => {
    await connections.get<any>().deleteFrom(PASSKEYS_TABLE).execute();
    await connections.get<any>().deleteFrom(RECOVERY_CODES_TABLE).execute();
  });

  const passkey = (overrides: Partial<NewPasskey> = {}): NewPasskey => ({
    userId: 1,
    userHandle: 'handle-1',
    credentialId: 'cred-1',
    publicKey: 'key-1',
    algorithm: -7,
    signCount: 0,
    transports: ['internal'],
    aaguid: '00000000-0000-0000-0000-000000000000',
    backupEligible: true,
    backedUp: false,
    name: 'Laptop',
    ...overrides,
  });
  async function created(overrides: Partial<NewPasskey> = {}) {
    const result = await store.create(passkey(overrides));
    if (!result.ok) throw new Error('duplicate');
    return result.value;
  }

  it('is a factor of the account that has a passkey, only', async () => {
    expect(await store.factors(1)).toEqual([]);
    expect(await store.enabledSince(1)).toBeUndefined();
    await created();
    expect(await store.factors(1)).toEqual(['passkey']);
    expect(await store.factors(2)).toEqual([]);
    expect((await store.enabledSince(1))!.getTime()).toBeGreaterThan(Date.now() - 5000);
  });

  it('stores and returns a passkey as it was registered', async () => {
    const record = await created({ transports: ['usb', 'nfc'], signCount: 3 });
    expect(record).toMatchObject({
      userId: 1,
      userHandle: 'handle-1',
      credentialId: 'cred-1',
      publicKey: 'key-1',
      algorithm: -7,
      signCount: 3,
      transports: ['usb', 'nfc'],
      backupEligible: true,
      backedUp: false,
      name: 'Laptop',
      lastUsedAt: null,
    });
    expect(await store.findByCredentialId('cred-1')).toEqual(record);
    expect(await store.findByCredentialId('nope')).toBeUndefined();
  });

  it('answers a credential id that is already registered with duplicate, for any account', async () => {
    await created();
    expect(await store.create(passkey({ userId: 1 }))).toMatchObject({ ok: false, error: { kind: 'duplicate' } });
    expect(await store.create(passkey({ userId: 2, userHandle: 'handle-2' }))).toMatchObject({ ok: false, error: { kind: 'duplicate' } });
    expect(await store.forUser(1)).toHaveLength(1);
    expect(await store.forUser(2)).toHaveLength(0);
  });

  it('offers the stored user handle, a fresh one for an account without passkeys, and stores the one it is given', async () => {
    const fresh = await store.userHandle(1);
    expect(fresh).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fresh).not.toBe(await store.userHandle(1)); // nothing stored yet
    await created({ userHandle: fresh });
    expect(await store.userHandle(1)).toBe(fresh);
    // The authenticator holds the handle of its own options: a passkey registered under another one is stored with that one.
    const second = await created({ credentialId: 'cred-2', userHandle: 'from-the-options' });
    expect(second.userHandle).toBe('from-the-options');
    expect(await store.userHandle(2)).not.toBe(fresh);
  });

  it('says since when the account has had a passkey: its oldest, moving on when that one goes', async () => {
    let now = Date.parse('2026-03-01T00:00:00Z');
    const clock: Clock = { now: () => now };
    const timed = new PasskeyStore(connections, clock);
    const first = await timed.create({ ...passkey(), credentialId: 'c-old' });
    now = Date.parse('2026-04-01T00:00:00Z');
    await timed.create({ ...passkey(), credentialId: 'c-new' });
    expect((await timed.enabledSince(1))!.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    await timed.remove(1, first.ok ? first.value.id : 0);
    expect((await timed.enabledSince(1))!.toISOString()).toBe('2026-04-01T00:00:00.000Z');
  });

  it('combines with the authenticator: the factors of both, since the earlier of the two', async () => {
    let now = Date.parse('2026-05-01T00:00:00Z');
    const clock: Clock = { now: () => now };
    const timed = new PasskeyStore(connections, clock);
    const totp = new TwoFactorStore(connections, clock);
    const both = combineFactors(totp, timed);
    await totp.startSetup(1, 'enc');
    now = Date.parse('2026-06-01T00:00:00Z');
    await totp.confirm(1, 5, 'enc', null);
    now = Date.parse('2026-05-15T00:00:00Z');
    await timed.create(passkey());
    expect([...(await both.factors(1))].sort()).toEqual(['passkey', 'totp']);
    expect((await both.enabledSince(1))!.toISOString()).toBe('2026-05-15T00:00:00.000Z');
    await connections.get<any>().deleteFrom(TWO_FACTOR_TABLE).execute();
  });

  it('lets exactly one of parallel sign-ins move the counter', async () => {
    const { id } = await created({ signCount: 4 });
    const results = await Promise.all(Array.from({ length: 6 }, () => store.updateCounter(id, 4, 5, false)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await store.findByCredentialId('cred-1'))!).toMatchObject({ signCount: 5, backedUp: false });
    expect((await store.findByCredentialId('cred-1'))!.lastUsedAt).toBeInstanceOf(Date);
    expect(await store.updateCounter(id, 4, 6, false)).toBe(false);
    expect(await store.updateCounter(id, 5, 6, true)).toBe(true);
    expect((await store.findByCredentialId('cred-1'))!.backedUp).toBe(true);
  });

  it('renames and removes only the account\'s own passkeys', async () => {
    const { id } = await created();
    expect(await store.rename(2, id, 'Stolen')).toBe(false);
    expect(await store.rename(1, id, 'Phone')).toBe(true);
    expect((await store.forUser(1))[0]!.name).toBe('Phone');
    expect(await store.remove(2, id)).toEqual({ removed: false, lastFactor: false });
    expect(await store.remove(1, id)).toEqual({ removed: true, lastFactor: true });
    expect(await store.factors(1)).toEqual([]);
  });

  describe('the recovery codes', () => {
    const codes = () => connections.get<any>().selectFrom(RECOVERY_CODES_TABLE).selectAll().execute();
    const seedCodes = async () => {
      const now = new Date();
      await connections.get<any>().insertInto(RECOVERY_CODES_TABLE).values({ user_id: 1, code_hash: 'a', used_at: null, created_at: now, updated_at: now }).execute();
    };

    it('stay while another passkey is left, and go with the last factor', async () => {
      const first = await created();
      const second = await created({ credentialId: 'cred-2' });
      await seedCodes();
      expect(await store.remove(1, first.id)).toEqual({ removed: true, lastFactor: false });
      expect(await codes()).toHaveLength(1);
      expect(await store.remove(1, second.id)).toEqual({ removed: true, lastFactor: true });
      expect(await codes()).toHaveLength(0);
    });

    it('stay when the last passkey goes but a confirmed authenticator remains', async () => {
      const only = await created();
      const totp = new TwoFactorStore(connections, new SystemClock());
      await totp.startSetup(1, 'enc');
      await totp.confirm(1, 5, 'enc', null);
      await seedCodes();
      expect(await store.remove(1, only.id)).toEqual({ removed: true, lastFactor: false });
      expect(await codes()).toHaveLength(1);
      await connections.get<any>().deleteFrom(TWO_FACTOR_TABLE).execute();
    });

    it('go when only an unconfirmed authenticator setup remains: that is no factor', async () => {
      const only = await created();
      const totp = new TwoFactorStore(connections, new SystemClock());
      await totp.startSetup(1, 'enc');
      await seedCodes();
      expect(await store.remove(1, only.id)).toEqual({ removed: true, lastFactor: true });
      expect(await codes()).toHaveLength(0);
      await connections.get<any>().deleteFrom(TWO_FACTOR_TABLE).execute();
    });
  });

  it('lists the account\'s passkeys oldest first and removes them all for a reset', async () => {
    await created();
    await created({ credentialId: 'cred-2', name: 'Phone' });
    await created({ userId: 2, userHandle: 'h2', credentialId: 'cred-3' });
    expect((await store.forUser(1)).map((record) => record.name)).toEqual(['Laptop', 'Phone']);
    await store.removeAll(1);
    expect(await store.forUser(1)).toHaveLength(0);
    expect(await store.forUser(2)).toHaveLength(1);
  });
});

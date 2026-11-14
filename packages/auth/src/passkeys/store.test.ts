import { SystemClock, type Clock } from '@marmeon/core';
import type { Connections } from '@marmeon/database';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drivers, migratedConnections } from '../__fixtures__/databases.ts';
import { expectUnchanged, optionsFor, setCases, setsOf, snapshot } from '../__fixtures__/table-sets.ts';
import { combineFactors } from '../two-factor/state.ts';
import { RECOVERY_CODES_TABLE, TWO_FACTOR_TABLE, TwoFactorStore } from '../two-factor/store.ts';
import { PASSKEYS_TABLE, PasskeyStore, type NewPasskey } from './store.ts';

// Each case runs on a set of tables (the app's, then a prefixed one) with the other set holding a passkey, an authenticator and codes of the same account, which must come out unchanged.
describe.each(setCases)('PasskeyStore on %s, on the %s tables', (driver, setName) => {
  const { own, other } = setsOf(setName);
  let before: string;
  const otherTables = [other.passkeys, other.twoFactor, other.recoveryCodes];
  let connections: Connections;
  let close: () => Promise<void>;
  let store: PasskeyStore;

  beforeAll(async () => {
    ({ connections, close } = await migratedConnections(driver, undefined, undefined, true));
    store = new PasskeyStore(connections, new SystemClock(), optionsFor(own).passkeys);
  });
  afterAll(() => close());
  beforeEach(async () => {
    for (const table of [own.passkeys, own.twoFactor, own.recoveryCodes, ...otherTables]) await connections.get<any>().deleteFrom(table).execute();
    const others = new PasskeyStore(connections, new SystemClock(), optionsFor(other).passkeys);
    await others.create({ ...passkey(), credentialId: 'other-credential', userHandle: 'other-handle' });
    const otherTotp = new TwoFactorStore(connections, new SystemClock(), optionsFor(other).twoFactor);
    await otherTotp.startSetup(1, 'other-secret');
    await otherTotp.confirm(1, 7, 'other-secret', ['other-a']);
    before = await snapshot(connections, otherTables);
  });
  afterEach(async () => expectUnchanged(before, await snapshot(connections, otherTables)));

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
    const timed = new PasskeyStore(connections, clock, optionsFor(own).passkeys);
    const first = await timed.create({ ...passkey(), credentialId: 'c-old' });
    now = Date.parse('2026-04-01T00:00:00Z');
    await timed.create({ ...passkey(), credentialId: 'c-new' });
    expect((await timed.enabledSince(1))!.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    await timed.remove(1, first.ok ? first.value.id : 0, { lastFactorAllowed: true });
    expect((await timed.enabledSince(1))!.toISOString()).toBe('2026-04-01T00:00:00.000Z');
  });

  it('combines with the authenticator: the factors of both, since the earlier of the two', async () => {
    let now = Date.parse('2026-05-01T00:00:00Z');
    const clock: Clock = { now: () => now };
    const timed = new PasskeyStore(connections, clock, optionsFor(own).passkeys);
    const totp = new TwoFactorStore(connections, clock, optionsFor(own).twoFactor);
    const both = combineFactors(totp, timed);
    await totp.startSetup(1, 'enc');
    now = Date.parse('2026-06-01T00:00:00Z');
    await totp.confirm(1, 5, 'enc', null);
    now = Date.parse('2026-05-15T00:00:00Z');
    await timed.create(passkey());
    expect([...(await both.factors(1))].sort()).toEqual(['passkey', 'totp']);
    expect((await both.enabledSince(1))!.toISOString()).toBe('2026-05-15T00:00:00.000Z');
    await connections.get<any>().deleteFrom(own.twoFactor).execute();
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
    expect(await store.remove(2, id, { lastFactorAllowed: true })).toMatchObject({ ok: false, error: { kind: 'not-found' } });
    expect(await store.remove(1, id, { lastFactorAllowed: true })).toMatchObject({ ok: true, value: { lastFactor: true } });
    expect(await store.factors(1)).toEqual([]);
  });

  describe('the recovery codes', () => {
    const codes = () => connections.get<any>().selectFrom(own.recoveryCodes).selectAll().execute();
    const seedCodes = async () => {
      const now = new Date();
      await connections.get<any>().insertInto(own.recoveryCodes).values({ user_id: 1, code_hash: 'a', used_at: null, created_at: now, updated_at: now }).execute();
    };

    it('stay while another passkey is left, and go with the last factor', async () => {
      const first = await created();
      const second = await created({ credentialId: 'cred-2' });
      await seedCodes();
      expect(await store.remove(1, first.id, { lastFactorAllowed: true })).toMatchObject({ ok: true, value: { lastFactor: false } });
      expect(await codes()).toHaveLength(1);
      expect(await store.remove(1, second.id, { lastFactorAllowed: true })).toMatchObject({ ok: true, value: { lastFactor: true } });
      expect(await codes()).toHaveLength(0);
    });

    it('stay when the last passkey goes but a confirmed authenticator remains', async () => {
      const only = await created();
      const totp = new TwoFactorStore(connections, new SystemClock(), optionsFor(own).twoFactor);
      await totp.startSetup(1, 'enc');
      await totp.confirm(1, 5, 'enc', null);
      await seedCodes();
      expect(await store.remove(1, only.id, { lastFactorAllowed: true })).toMatchObject({ ok: true, value: { lastFactor: false } });
      expect(await codes()).toHaveLength(1);
      await connections.get<any>().deleteFrom(own.twoFactor).execute();
    });

    it('refuse the last factor unless it is allowed, and then change nothing', async () => {
      const only = await created();
      await seedCodes();
      expect(await store.remove(1, only.id, { lastFactorAllowed: false })).toMatchObject({ ok: false, error: { kind: 'last-factor' } });
      expect(await store.factors(1)).toEqual(['passkey']);
      expect(await codes()).toHaveLength(1);
    });

    it('leave a factor when the last two are removed in parallel without permission', async () => {
      const first = await created();
      const second = await created({ credentialId: 'cred-2' });
      await seedCodes();
      const results = await Promise.all([store.remove(1, first.id, { lastFactorAllowed: false }), store.remove(1, second.id, { lastFactorAllowed: false })]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(await store.factors(1)).toEqual(['passkey']);
      expect(await codes()).toHaveLength(1);
    });

    it('go when only an unconfirmed authenticator setup remains: that is no factor', async () => {
      const only = await created();
      const totp = new TwoFactorStore(connections, new SystemClock(), optionsFor(own).twoFactor);
      await totp.startSetup(1, 'enc');
      await seedCodes();
      expect(await store.remove(1, only.id, { lastFactorAllowed: true })).toMatchObject({ ok: true, value: { lastFactor: true } });
      expect(await codes()).toHaveLength(0);
      await connections.get<any>().deleteFrom(own.twoFactor).execute();
    });
  });

  it('hides a suspended passkey from the lookup until it is released, and still lists it', async () => {
    const { id } = await created();
    expect(await store.suspend(id)).toBe(true);
    expect(await store.suspend(id)).toBe(false);
    expect(await store.findByCredentialId('cred-1')).toBeUndefined();
    expect((await store.forUser(1))[0]!.suspendedAt).toBeInstanceOf(Date);
    expect(await store.release(2, id)).toBe(false);
    expect(await store.release(1, id)).toBe(true);
    expect(await store.release(1, id)).toBe(false);
    expect((await store.findByCredentialId('cred-1'))!.suspendedAt).toBeNull();
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

describe.each(drivers)('PasskeyStore on tables of its own on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  const tables = { passkeys: 'office_passkeys', twoFactor: 'office_two_factor_authentications', recoveryCodes: 'office_two_factor_recovery_codes' };
  const count = async (table: string) => (await connections.get<any>().selectFrom(table).selectAll().execute()).length;
  const code = async (table: string, userId: number) => {
    const now = new Date();
    await connections.get<any>().insertInto(table).values({ user_id: userId, code_hash: 'a', used_at: null, created_at: now, updated_at: now }).execute();
  };
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

  beforeAll(async () => {
    ({ connections, close } = await migratedConnections(driver, undefined, undefined, true));
  });
  afterAll(() => close());
  beforeEach(async () => {
    for (const table of [PASSKEYS_TABLE, TWO_FACTOR_TABLE, RECOVERY_CODES_TABLE, ...Object.values(tables)]) await connections.get<any>().deleteFrom(table).execute();
  });

  it('keeps the passkeys in its table and leaves the app table empty', async () => {
    const office = new PasskeyStore(connections, new SystemClock(), { tables });
    const result = await office.create(passkey());
    expect(result.ok).toBe(true);
    expect(await office.factors(1)).toEqual(['passkey']);
    expect((await office.findByCredentialId('cred-1'))?.name).toBe('Laptop');
    expect(await count(tables.passkeys)).toBe(1);
    expect(await count(PASSKEYS_TABLE)).toBe(0);
    await office.removeAll(1);
    expect(await count(tables.passkeys)).toBe(0);
  });

  it('sees no passkey of the app table, and an app passkey does not make the credential a duplicate', async () => {
    const app = new PasskeyStore(connections, new SystemClock());
    const office = new PasskeyStore(connections, new SystemClock(), { tables });
    await app.create(passkey());
    expect(await office.factors(1)).toEqual([]);
    expect(await office.findByCredentialId('cred-1')).toBeUndefined();
    expect((await office.create(passkey())).ok).toBe(true);
  });

  it('deletes the recovery codes of its own table with the last factor, not those of the app table', async () => {
    const office = new PasskeyStore(connections, new SystemClock(), { tables });
    const created = await office.create(passkey());
    if (!created.ok) throw new Error('duplicate');
    await code(tables.recoveryCodes, 1);
    await code(RECOVERY_CODES_TABLE, 1);
    expect(await office.remove(1, created.value.id, { lastFactorAllowed: true })).toMatchObject({ ok: true, value: { lastFactor: true } });
    expect(await count(tables.recoveryCodes)).toBe(0);
    expect(await count(RECOVERY_CODES_TABLE)).toBe(1);
  });

  it('looks for a confirmed authenticator in its own table, not the app table', async () => {
    const office = new PasskeyStore(connections, new SystemClock(), { tables });
    const appTotp = new TwoFactorStore(connections, new SystemClock());
    await appTotp.startSetup(1, 'enc');
    await appTotp.confirm(1, 5, 'enc', null);
    const created = await office.create(passkey());
    if (!created.ok) throw new Error('duplicate');
    await code(tables.recoveryCodes, 1);
    // The app's authenticator is not a factor of this circle: refused as the last one, and the account's codes in this circle are kept.
    expect(await office.remove(1, created.value.id, { lastFactorAllowed: false })).toMatchObject({ ok: false, error: { kind: 'last-factor' } });
    expect(await count(tables.passkeys)).toBe(1);
    expect(await count(tables.recoveryCodes)).toBe(1);
  });

  it('refuses a table name that is not plain', () => {
    expect(() => new PasskeyStore(connections, new SystemClock(), { tables: { passkeys: 'x;drop' } })).toThrow(TypeError);
    expect(() => new PasskeyStore(connections, new SystemClock(), { tables: { twoFactor: 'a.b' } })).toThrow(TypeError);
    expect(() => new PasskeyStore(connections, new SystemClock(), { tables: { recoveryCodes: '' } })).toThrow(TypeError);
  });
});

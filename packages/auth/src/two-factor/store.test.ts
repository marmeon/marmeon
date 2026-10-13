import { SystemClock } from '@marmeon/core';
import { secret, type Connections } from '@marmeon/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drivers, migratedConnections } from '../__fixtures__/databases.ts';
import { RECOVERY_CODES_TABLE, TWO_FACTOR_TABLE, TwoFactorStore, type RecoveryCodeTable, type TwoFactorTable } from './store.ts';

describe.each(drivers)('TwoFactorStore on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  let store: TwoFactorStore;
  const hashes = (count: number, prefix = 'h') => Array.from({ length: count }, (_, i) => `${prefix}${i}`);
  const rows = (table: string) => connections.get<any>().selectFrom(table).selectAll().execute();

  beforeAll(async () => {
    ({ connections, close } = await migratedConnections(driver));
    store = new TwoFactorStore(connections, new SystemClock());
  });
  afterAll(() => close());
  beforeEach(async () => {
    await connections.get<any>().deleteFrom(TWO_FACTOR_TABLE).execute();
    await connections.get<any>().deleteFrom(RECOVERY_CODES_TABLE).execute();
  });

  /** A confirmed authenticator whose last used step is 100. */
  async function confirmed(userId = 1, codes: string[] | null = null) {
    await store.startSetup(userId, 'enc-1');
    expect(await store.confirm(userId, 100, 'enc-2', codes)).toBe(true);
  }

  describe('setup', () => {
    it('lists no factor for an unconfirmed setup and for an account without one', async () => {
      expect(await store.factors(1)).toEqual([]);
      await store.startSetup(1, 'enc-1');
      expect(await store.factors(1)).toEqual([]);
      expect(await store.find(1)).toEqual({ encryptedSecret: 'enc-1', confirmed: false, lastUsedStep: null });
    });

    it('lists totp once confirmed, only for that account', async () => {
      await confirmed(1);
      expect(await store.factors(1)).toEqual(['totp']);
      expect(await store.factors(2)).toEqual([]);
      expect(await store.find(1)).toEqual({ encryptedSecret: 'enc-2', confirmed: true, lastUsedStep: 100 });
    });

    it('says since when the factor is on — its confirmation — and nothing for an unconfirmed setup or another account', async () => {
      expect(await store.enabledSince(1)).toBeUndefined();
      await store.startSetup(1, 'enc-1');
      expect(await store.enabledSince(1)).toBeUndefined();
      const before = Date.now();
      await store.confirm(1, 5, 'enc-2', null);
      const since = await store.enabledSince(1);
      expect(since!.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(await store.enabledSince(2)).toBeUndefined();
    });

    it('replaces an unconfirmed setup, but refuses to start over a confirmed one', async () => {
      await store.startSetup(1, 'enc-1');
      await store.startSetup(1, 'enc-new');
      expect((await store.find(1))?.encryptedSecret).toBe('enc-new');
      expect(await rows(TWO_FACTOR_TABLE)).toHaveLength(1);
      await store.confirm(1, 5, 'enc-2', null);
      await expect(store.startSetup(1, 'enc-3')).rejects.toThrow('disable it first');
      expect((await store.find(1))?.encryptedSecret).toBe('enc-2');
    });

    it('survives parallel starts for one account: one row remains, none fails raw', async () => {
      const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => store.startSetup(1, `enc-${i}`)));
      expect(results.map((result) => result.status)).toEqual(Array.from({ length: 6 }, () => 'fulfilled'));
      expect(await rows(TWO_FACTOR_TABLE)).toHaveLength(1);
      expect((await store.find(1))?.confirmed).toBe(false);
    });

    it('does not confirm twice or without a setup', async () => {
      expect(await store.confirm(1, 5, 'enc', null)).toBe(false);
      await confirmed(1, hashes(2));
      expect(await store.confirm(1, 200, 'other', hashes(3, 'x'))).toBe(false);
      expect(await store.find(1)).toMatchObject({ encryptedSecret: 'enc-2', lastUsedStep: 100 });
      expect(await store.remainingRecoveryCodes(1)).toBe(2);
    });

    it('keeps what it is given: the (already encrypted) secret and the hashes, nothing else', async () => {
      await confirmed(1, ['hash-a']);
      const db = connections.get<{ [TWO_FACTOR_TABLE]: TwoFactorTable; [RECOVERY_CODES_TABLE]: RecoveryCodeTable }>();
      expect(await db.selectFrom(TWO_FACTOR_TABLE).select((eb) => [secret(eb, 'secret')]).execute()).toEqual([{ secret: 'enc-2' }]);
      expect(await db.selectFrom(RECOVERY_CODES_TABLE).select((eb) => [secret(eb, 'code_hash'), 'used_at']).execute()).toEqual([{ code_hash: 'hash-a', used_at: null }]);
    });

    it('confirm rolls back completely when the recovery codes cannot be stored', async () => {
      await store.startSetup(1, 'enc-1');
      await expect(store.confirm(1, 100, 'enc-2', ['dup', 'dup'])).rejects.toThrow();
      expect(await store.factors(1)).toEqual([]);
      expect(await store.find(1)).toEqual({ encryptedSecret: 'enc-1', confirmed: false, lastUsedStep: null });
      expect(await rows(RECOVERY_CODES_TABLE)).toEqual([]);
    });

    it('stores the recovery codes with the confirmation only when it is the first factor', async () => {
      await confirmed(1, hashes(10));
      expect(await store.remainingRecoveryCodes(1)).toBe(10);
      await store.startSetup(2, 'enc');
      await store.confirm(2, 1, 'enc', null);
      expect(await store.remainingRecoveryCodes(2)).toBe(0);
    });
  });

  describe('useStep', () => {
    it('accepts a step once: the same step twice and a smaller step after a larger one are refused', async () => {
      await confirmed();
      expect(await store.useStep(1, 101, 'enc-3')).toBe(true);
      expect(await store.useStep(1, 101, 'enc-4')).toBe(false);
      expect(await store.useStep(1, 100, 'enc-4')).toBe(false);
      expect(await store.useStep(1, 102, 'enc-5')).toBe(true);
      expect(await store.find(1)).toMatchObject({ encryptedSecret: 'enc-5', lastUsedStep: 102 });
    });

    it('also refuses the step the confirmation used', async () => {
      await confirmed();
      expect(await store.useStep(1, 100, 'enc-3')).toBe(false);
      expect((await store.find(1))?.encryptedSecret).toBe('enc-2');
    });

    it('lets exactly one of 20 parallel requests with the same step win', async () => {
      await confirmed();
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) => store.useStep(1, 101, `enc-${i}`)));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect((await store.find(1))?.lastUsedStep).toBe(101);
    });

    it('never moves the step backwards under parallel requests with different steps', async () => {
      await confirmed();
      await Promise.all([105, 101, 103, 102, 104].map((step) => store.useStep(1, step, `enc-${step}`)));
      expect((await store.find(1))?.lastUsedStep).toBe(105);
    });

    it('does nothing for an unconfirmed setup or an unknown account', async () => {
      await store.startSetup(1, 'enc-1');
      expect(await store.useStep(1, 50, 'enc-x')).toBe(false);
      expect(await store.useStep(9, 50, 'enc-x')).toBe(false);
      expect(await store.find(1)).toEqual({ encryptedSecret: 'enc-1', confirmed: false, lastUsedStep: null });
    });
  });

  describe('recovery codes', () => {
    it('spends a code once and reports how many are left', async () => {
      await confirmed(1, hashes(3));
      expect(await store.consumeRecoveryCode(1, 'h0')).toBe(2);
      expect(await store.consumeRecoveryCode(1, 'h0')).toBeUndefined();
      expect(await store.consumeRecoveryCode(1, 'h1')).toBe(1);
    });

    it('lets exactly one of 20 parallel requests spend the same code', async () => {
      await confirmed(1, hashes(3));
      const results = await Promise.all(Array.from({ length: 20 }, () => store.consumeRecoveryCode(1, 'h2')));
      expect(results.filter((left) => left !== undefined)).toHaveLength(1);
      expect(await store.remainingRecoveryCodes(1)).toBe(2);
    });

    it('refuses an unknown code and another account\'s code', async () => {
      await confirmed(1, hashes(2));
      expect(await store.consumeRecoveryCode(1, 'nope')).toBeUndefined();
      expect(await store.consumeRecoveryCode(2, 'h0')).toBeUndefined();
      expect(await store.remainingRecoveryCodes(1)).toBe(2);
    });

    it('replaces all codes, spent ones included', async () => {
      await confirmed(1, hashes(3));
      await store.consumeRecoveryCode(1, 'h0');
      await store.replaceRecoveryCodes(1, hashes(10, 'n'));
      expect(await store.remainingRecoveryCodes(1)).toBe(10);
      expect(await store.consumeRecoveryCode(1, 'h1')).toBeUndefined();
      expect(await store.consumeRecoveryCode(1, 'n0')).toBe(9);
    });

    it('keeps the old codes when the replacement fails', async () => {
      await confirmed(1, hashes(3));
      await expect(store.replaceRecoveryCodes(1, ['d', 'd'])).rejects.toThrow();
      expect(await store.remainingRecoveryCodes(1)).toBe(3);
    });
  });

  describe('removal', () => {
    it('removes only the authenticator when other factors remain', async () => {
      await confirmed(1, hashes(3));
      await store.removeTotp(1, { lastFactor: false });
      expect(await store.factors(1)).toEqual([]);
      expect(await store.remainingRecoveryCodes(1)).toBe(3);
    });

    it('removes the recovery codes with the last factor, for that account only', async () => {
      await confirmed(1, hashes(3));
      await confirmed(2, hashes(2, 'o'));
      await store.removeTotp(1, { lastFactor: true });
      expect(await store.find(1)).toBeUndefined();
      expect(await store.remainingRecoveryCodes(1)).toBe(0);
      expect(await store.factors(2)).toEqual(['totp']);
      expect(await store.remainingRecoveryCodes(2)).toBe(2);
    });

    it('removeAll drops the setup, the factor and the codes', async () => {
      await confirmed(1, hashes(3));
      await store.removeAll(1);
      expect(await rows(TWO_FACTOR_TABLE)).toEqual([]);
      expect(await rows(RECOVERY_CODES_TABLE)).toEqual([]);
    });
  });
});

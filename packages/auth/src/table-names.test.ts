import { SchemaRequirements } from '@marmeon/database';
import { describe, expect, it } from 'vitest';
import { assertTableName } from './table-names.ts';
import { requireStoreTables } from './upgrades.ts';

describe('assertTableName', () => {
  it('passes a plain lower-case name through', () => {
    expect(assertTableName('Store', 'office_sign_ins')).toBe('office_sign_ins');
    expect(assertTableName('Store', 'a'.repeat(63))).toBe('a'.repeat(63));
  });

  it('throws a TypeError naming the store for anything else', () => {
    for (const name of ['x;drop', 'Office', '', 'a.b', 'a b', '1a', '"x"', 'office-users', 'a'.repeat(64)]) {
      expect(() => assertTableName('Store', name), name).toThrow(TypeError);
    }
  });
});

describe('requireStoreTables', () => {
  it('requires the tables it is given, with the columns and secrets of their stores, and none it is not given', () => {
    const requirements = new SchemaRequirements();
    requireStoreTables(requirements, {
      connection: 'default',
      tables: { signIns: 'office_sign_ins', passwordResets: 'office_password_reset_tokens', twoFactor: { factor: 'office_two_factor_authentications', recoveryCodes: 'office_two_factor_recovery_codes' } },
    });
    const all = requirements.all();
    expect(all.map((requirement) => requirement.table).sort()).toEqual(['office_password_reset_tokens', 'office_sign_ins', 'office_two_factor_authentications', 'office_two_factor_recovery_codes']);
    expect(all.every((requirement) => requirement.connection === 'default')).toBe(true);
    expect(all.find((requirement) => requirement.table === 'office_two_factor_authentications')?.secrets).toEqual(['secret']);
  });
});

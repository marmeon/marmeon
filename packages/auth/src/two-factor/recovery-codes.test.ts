import { describe, expect, it } from 'vitest';
import { generateRecoveryCodes, hashRecoveryCode, normalizeRecoveryCode, RECOVERY_CODE_COUNT } from './recovery-codes.ts';

describe('generateRecoveryCodes', () => {
  it('makes ten distinct codes of four groups of four Crockford characters', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    // Normalizing must not merge two codes: a generated code, typed in lower case without hyphens, is itself and hashes alike.
    for (const code of codes) {
      const typed = code.toLowerCase().replaceAll('-', '');
      expect(normalizeRecoveryCode(typed)).toBe(code.replaceAll('-', ''));
      expect(hashRecoveryCode(1, typed)).toBe(hashRecoveryCode(1, code));
    }
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
  });

  it('honours the requested count', () => {
    expect(generateRecoveryCodes(3)).toHaveLength(3);
  });
});

describe('normalizeRecoveryCode', () => {
  it('upper-cases and drops spaces and hyphens', () => {
    expect(normalizeRecoveryCode(' abcd-efgh 1234-5678 ')).toBe('ABCDEFGH12345678');
  });

  it('reads O as 0 and I and L as 1', () => {
    expect(normalizeRecoveryCode('oOiIlL')).toBe('001111');
  });
});

describe('hashRecoveryCode', () => {
  it('is a SHA-256 hex digest that ignores formatting and look-alike characters', () => {
    const hash = hashRecoveryCode(1, 'ABCD-EFGH-1234-5678');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRecoveryCode(1, 'abcd efgh 1234 5678')).toBe(hash);
    expect(hashRecoveryCode(1, '0000-0000-0000-0001')).toBe(hashRecoveryCode(1, 'OOOO-oooo-0000-000l'));
  });

  it('is bound to the user: the same code hashes differently for another account', () => {
    expect(hashRecoveryCode(1, 'ABCD-EFGH-1234-5678')).not.toBe(hashRecoveryCode(2, 'ABCD-EFGH-1234-5678'));
  });

  it('differs per code and is stable', () => {
    expect(hashRecoveryCode(1, 'ABCD-EFGH-1234-5678')).not.toBe(hashRecoveryCode(1, 'ABCD-EFGH-1234-5679'));
    expect(hashRecoveryCode(1, 'ABCD-EFGH-1234-5678')).toBe(hashRecoveryCode(1, 'ABCD-EFGH-1234-5678'));
  });
});

import { createHash, randomBytes } from 'node:crypto';

/** Crockford Base32: no I, L, O, U, so a code read aloud or copied by hand survives. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_BYTES = 10; // 80 bits = 16 characters

/** How many codes an account gets at once. */
export const RECOVERY_CODE_COUNT = 10;

/** `count` fresh codes, shown as `XXXX-XXXX-XXXX-XXXX` (80 bits each). */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    let chars = '';
    let buffer = 0;
    let bits = 0;
    for (const byte of randomBytes(CODE_BYTES)) {
      buffer = (buffer << 8) | byte;
      bits += 8;
      while (bits >= 5) {
        chars += ALPHABET[(buffer >>> (bits - 5)) & 31];
        bits -= 5;
      }
      buffer &= (1 << bits) - 1;
    }
    return chars.match(/.{4}/g)!.join('-');
  });
}

/** What a user typed, reduced to the form that is hashed: upper case, no spaces or hyphens, `O` read as 0, `I` and `L` as 1. */
export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, '').replaceAll('O', '0').replace(/[IL]/g, '1');
}

/**
 * SHA-256 of the normalized code under a fixed prefix. A fast hash is enough at 80 bits of entropy, and the hash does not
 * depend on `APP_KEY`, so codes stay valid when the key rotates.
 */
export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(`marmeon-auth:recovery:${normalizeRecoveryCode(code)}`).digest('hex');
}

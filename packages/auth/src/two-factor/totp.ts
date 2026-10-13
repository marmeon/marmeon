import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Seconds a TOTP code lives: the one period every authenticator app supports. */
export const TOTP_PERIOD = 30;
/** Digits of a code, for the same reason. */
export const TOTP_DIGITS = 6;
/** Bytes of a secret (RFC 4226 §4 asks for 160 bits). */
const SECRET_BYTES = 20;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 Base32 without padding. */
export function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31];
  return out;
}

/** Decodes RFC 4648 Base32 (any case, optional padding); `undefined` for any other character. */
export function base32Decode(text: string): Uint8Array | undefined {
  const clean = text.replace(/=+$/, '').toUpperCase();
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const value = BASE32.indexOf(char);
    if (value === -1) return undefined;
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
    buffer &= (1 << bits) - 1;
  }
  return Uint8Array.from(bytes);
}

/** A fresh secret: 20 random bytes, Base32-encoded (what the authenticator app is given). */
export function generateSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES));
}

/** HOTP (RFC 4226) for the raw key bytes and a counter; a zero-padded string of `digits` digits. */
export function hotp(key: Uint8Array, counter: number | bigint, digits = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', key).update(message).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const truncated = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(truncated % 10 ** digits).padStart(digits, '0');
}

/** The 30-second time step `at` falls into (RFC 6238 with T0 = 0). */
export function totpStep(at: Date): number {
  return Math.floor(at.getTime() / 1000 / TOTP_PERIOD);
}

/**
 * Checks `code` against the steps `t - window … t + window` (RFC 6238 §5.2) and returns the matching step, `undefined` when
 * none does. Every candidate is computed and compared in constant time with no early exit, and input that is not six digits
 * runs through the same work — so neither the position of a match nor the shape of a guess shows in the timing.
 * The caller must refuse a step it has already accepted (or an older one): that is what stops a code being used twice.
 */
export function verifyTotp(secret: string, code: string, at: Date, window = 1): number | undefined {
  const key = base32Decode(secret);
  // Fail closed on anything but a secret we generate: RFC 4226 R6 asks for at least 128 bits, and a lenient decode must not shrink it.
  if (key === undefined || key.length !== SECRET_BYTES) return undefined;
  const wellFormed = /^\d{6}$/.test(code);
  // 0xff never occurs in a digit string, so a malformed guess matches no candidate.
  const guess = wellFormed ? Buffer.from(code, 'ascii') : Buffer.alloc(TOTP_DIGITS, 0xff);
  const current = totpStep(at);
  let matched: number | undefined;
  for (let step = current - window; step <= current + window; step++) {
    const candidate = Buffer.from(hotp(key, Math.max(step, 0)), 'ascii');
    const equal = timingSafeEqual(candidate, guess);
    if (equal && (matched === undefined || step > matched)) matched = step;
  }
  return matched;
}

/**
 * The `otpauth://` URI authenticator apps read from the QR code. A colon in the issuer or account would split the label, so
 * each is replaced by a space and the whitespace collapsed (`My: App` becomes `My App`). Throws for a `secret` that is not
 * unpadded Base32 (it would otherwise inject parameters) and for an issuer that is empty after that.
 */
export function otpauthUri(input: { issuer: string; account: string; secret: string }): string {
  if (!/^[A-Z2-7]+$/.test(input.secret)) throw new TypeError('The TOTP secret must be unpadded upper-case Base32.');
  const label = (text: string) => text.replaceAll(':', ' ').replace(/\s+/g, ' ').trim();
  const issuerText = label(input.issuer);
  if (issuerText === '') throw new TypeError('The TOTP issuer must not be empty.');
  const issuer = encodeURIComponent(issuerText);
  const account = encodeURIComponent(label(input.account));
  return `otpauth://totp/${issuer}:${account}?secret=${input.secret}&issuer=${issuer}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD}`;
}

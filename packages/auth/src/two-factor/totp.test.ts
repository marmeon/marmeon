import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, generateSecret, hotp, otpauthUri, totpStep, verifyTotp } from './totp.ts';

const rfcKey = Buffer.from('12345678901234567890', 'ascii');
const rfcSecret = base32Encode(rfcKey);
const at = (seconds: number) => new Date(seconds * 1000);

describe('Base32 (RFC 4648)', () => {
  const vectors: [string, string][] = [['', ''], ['f', 'MY'], ['fo', 'MZXQ'], ['foo', 'MZXW6'], ['foob', 'MZXW6YQ'], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI']];

  it.each(vectors)('encodes %j as %s without padding', (plain, encoded) => {
    expect(base32Encode(Buffer.from(plain))).toBe(encoded);
  });

  it.each(vectors)('decodes %s back to %j, in any case and with padding', (plain, encoded) => {
    expect(Buffer.from(base32Decode(encoded)!).toString()).toBe(plain);
    expect(Buffer.from(base32Decode(encoded.toLowerCase())!).toString()).toBe(plain);
    expect(Buffer.from(base32Decode(encoded + '='.repeat((8 - (encoded.length % 8)) % 8))!).toString()).toBe(plain);
  });

  it('rejects characters outside the alphabet', () => {
    expect(base32Decode('MZXW6!')).toBeUndefined();
    expect(base32Decode('MZXW 6')).toBeUndefined();
    expect(base32Decode('MZXW1')).toBeUndefined();
    expect(base32Decode('MZ=XW')).toBeUndefined(); // padding only at the end
  });
});

describe('generateSecret', () => {
  it('is 20 random bytes as 32 Base32 characters', () => {
    const secret = generateSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(secret)).toHaveLength(20);
    expect(generateSecret()).not.toBe(secret);
  });
});

describe('TOTP (RFC 6238 Appendix B, SHA-1)', () => {
  // The RFC lists 8-digit values; the 6-digit code is their last six digits.
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ])('T = %i gives %s', (seconds, code) => {
    expect(hotp(rfcKey, totpStep(at(seconds)))).toBe(code);
    expect(verifyTotp(rfcSecret, code, at(seconds))).toBe(totpStep(at(seconds)));
  });

  it('computes the RFC 4226 HOTP values', () => {
    expect([0, 1, 2].map((counter) => hotp(rfcKey, counter))).toEqual(['755224', '287082', '359152']);
  });
});

describe('verifyTotp', () => {
  const now = at(1111111109);
  const step = totpStep(now);
  const codeAt = (s: number) => hotp(rfcKey, s);

  it('accepts the previous, the current and the next step and returns the one that matched', () => {
    expect(verifyTotp(rfcSecret, codeAt(step - 1), now)).toBe(step - 1);
    expect(verifyTotp(rfcSecret, codeAt(step), now)).toBe(step);
    expect(verifyTotp(rfcSecret, codeAt(step + 1), now)).toBe(step + 1);
  });

  it('refuses two steps away', () => {
    expect(verifyTotp(rfcSecret, codeAt(step - 2), now)).toBeUndefined();
    expect(verifyTotp(rfcSecret, codeAt(step + 2), now)).toBeUndefined();
  });

  it('widens or closes the window on request', () => {
    expect(verifyTotp(rfcSecret, codeAt(step + 2), now, 2)).toBe(step + 2);
    expect(verifyTotp(rfcSecret, codeAt(step + 1), now, 0)).toBeUndefined();
  });

  it.each(['abcdef', '', '12345 ', ' 123456', '1234567', '12345', '12345a', '１２３４５６'])('refuses the malformed input %j', (code) => {
    expect(verifyTotp(rfcSecret, code, now)).toBeUndefined();
  });

  it('refuses a wrong code and a secret that is not Base32', () => {
    expect(verifyTotp(rfcSecret, '000000', now)).toBeUndefined();
    expect(verifyTotp('not base32!', codeAt(step), now)).toBeUndefined();
    expect(verifyTotp('', codeAt(step), now)).toBeUndefined();
  });

  it('refuses a secret that does not decode to exactly 20 bytes, however lenient the decoding', () => {
    const short = Buffer.from('1234567890123456'); // 128 bits, but not what we generate
    expect(verifyTotp(base32Encode(short), hotp(short, step), now)).toBeUndefined();
    expect(verifyTotp(base32Encode(Buffer.from('1')), hotp(Buffer.from('1'), step), now)).toBeUndefined();
    const long = Buffer.from('123456789012345678901');
    expect(verifyTotp(base32Encode(long), hotp(long, step), now)).toBeUndefined();
    expect(verifyTotp(`${rfcSecret}${'='.repeat(9)}`, codeAt(step), now)).toBe(step); // padding is ignored, the length still is 20
  });

  it('copes with the first steps after the epoch', () => {
    expect(verifyTotp(rfcSecret, codeAt(0), at(0))).toBe(0);
  });
});

describe('otpauthUri', () => {
  it('writes the URI authenticator apps read', () => {
    expect(otpauthUri({ issuer: 'Acme', account: 'ada@example.com', secret: 'JBSWY3DPEHPK3PXP' })).toBe(
      'otpauth://totp/Acme:ada%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Acme&algorithm=SHA1&digits=6&period=30',
    );
  });

  it('URL-encodes issuer and account, replacing colons with a space and collapsing whitespace', () => {
    const uri = otpauthUri({ issuer: 'My: App & Co', account: 'a b+c@example.com', secret: 'AAAA' });
    expect(uri).toContain('otpauth://totp/My%20App%20%26%20Co:a%20b%2Bc%40example.com?');
    expect(uri).toContain('&issuer=My%20App%20%26%20Co&');
    expect(new URL(uri).searchParams.get('issuer')).toBe('My App & Co');
    expect(otpauthUri({ issuer: 'Acme', account: 'a:b@example.com', secret: 'AAAA' })).toContain('/Acme:a%20b%40example.com?');
  });

  it('throws for a secret that is not unpadded upper-case Base32, so no parameter can be injected', () => {
    for (const secret of ['X&issuer=Evil', '', 'abcd', 'AAAA====', 'AA AA']) {
      expect(() => otpauthUri({ issuer: 'Acme', account: 'a', secret })).toThrow(TypeError);
    }
  });

  it('throws for an issuer that is empty once normalized', () => {
    for (const issuer of ['', '  ', ':', ' : ']) expect(() => otpauthUri({ issuer, account: 'a', secret: 'AAAA' })).toThrow(TypeError);
  });
});

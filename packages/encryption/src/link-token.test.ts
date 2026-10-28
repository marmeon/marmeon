import { redactText } from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import { hashLinkToken, linkToken, type LinkToken } from './link-token.ts';

describe('linkToken()', () => {
  it('makes 32 random bytes as base64url — 43 characters, 256 bits', () => {
    const { token } = linkToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
  });

  it('never repeats itself', () => {
    const made = Array.from({ length: 1000 }, () => linkToken());
    expect(new Set(made.map((link) => link.token)).size).toBe(1000);
    expect(new Set(made.map((link) => link.hash)).size).toBe(1000);
  });

  it('hands out the hash that hashLinkToken() finds the token by — a hex SHA-256, not the token', () => {
    const { token, hash } = linkToken();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(token);
    expect(hash).not.toContain(token);
    expect(hashLinkToken(token)).toBe(hash);
    expect(hashLinkToken(token)).toBe(hashLinkToken(token));
  });

  it('is masked in a log line', () => {
    const { token } = linkToken();
    expect(redactText(`opened /lab/links/${token} just now`)).not.toContain(token);
  });

  it('is a pair of strings', () => {
    const link: LinkToken = linkToken();
    // @ts-expect-error — a link token is a pair, not a string
    const text: string = link;
    // @ts-expect-error — nothing else is in it
    const other = link.secret;
    expect([text, other]).toBeDefined();
  });
});

describe('hashLinkToken()', () => {
  it('hashes a misshapen value to something that is no token\'s hash — so it finds no row, and does not throw', () => {
    const { token, hash } = linkToken();
    for (const bad of ['', ' ', token.slice(1), `${token}A`, `${token.slice(0, 42)}+`, `${token}\n`, 'x'.repeat(100_000), 'ünïcode'.repeat(10)]) {
      const hashed = hashLinkToken(bad);
      expect(hashed).toMatch(/^[0-9a-f]{64}$/);
      expect(hashed).not.toBe(hash);
    }
  });

  it('hashes a misshapen value under a domain of its own — the same text as a token\'s hash is not a hash a token can have', async () => {
    const { createHash } = await import('node:crypto');
    const { token } = linkToken();
    // The 43 characters of a token hash under the token domain only: padding one makes a value that is hashed whole elsewhere.
    const sha = (text: string) => createHash('sha256').update(text).digest('hex');
    expect(hashLinkToken(token)).toBe(sha(`marmeon.link-token.v1\0${token}`));
    expect(hashLinkToken(`${token}x`)).not.toBe(sha(`marmeon.link-token.v1\0${token}x`));
  });

  it('cuts a long value, so it costs no more than a short one', () => {
    expect(hashLinkToken('a'.repeat(512))).toBe(hashLinkToken('a'.repeat(5000)));
  });

  it('takes what is no string without a throw', () => {
    expect(hashLinkToken(undefined as never)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashLinkToken(Object.create(null) as never)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashLinkToken(42 as never)).toMatch(/^[0-9a-f]{64}$/);
  });
});

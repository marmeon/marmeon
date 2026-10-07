import { SystemClock } from '@marmeon/core';
import type { EncryptionConfig } from '@marmeon/encryption';
import { generateKey } from '@marmeon/encryption';
import { defineRoutes, UrlSigner } from '@marmeon/http';
import { Router } from '@marmeon/router';
import { describe, expect, it } from 'vitest';
import { authenticate, EmailVerification, emailHash, verified } from './index.ts';

const router = new Router().load(
  defineRoutes((Route) => {
    Route.get('/email/verify', () => 'notice').name('auth.verification.notice');
    Route.get('/email/verify/:id/:hash', () => 'verify').name('auth.verification.verify');
  }),
);
const key = Buffer.from(generateKey().slice('base64:'.length), 'base64');
const signer = new UrlSigner(router, { key, previousKeys: [] } as unknown as EncryptionConfig, new SystemClock());
const verification = new EmailVerification(signer);
const ada = { id: 1, email: 'ada@example.com', email_verified_at: null };

describe('EmailVerification', () => {
  it('links to the verify route, signed and expiring, with the hash of the address', () => {
    const link = new URL(verification.link(ada, { base: 'https://app.example' }));
    expect(link.pathname).toBe(`/email/verify/1/${emailHash('ada@example.com')}`);
    expect(link.searchParams.get('expires')).toMatch(/^\d+$/);
    expect(signer.hasValidSignature(link)).toBe(true);
  });

  it('counter-checks: another user’s link, an old address — no match', () => {
    const params = { id: '1', hash: emailHash('ada@example.com') };
    expect(verification.matches(ada, params)).toBe(true);
    expect(verification.matches({ id: 2, email: 'alan@example.com' }, params)).toBe(false); // signed, but not yours
    expect(verification.matches({ id: 1, email: 'ada@new.example' }, params)).toBe(false); // the address changed since
    expect(verification.matches(ada, { id: '1', hash: 'short' })).toBe(false);
  });
});

describe('verified()', () => {
  const Verified = verified();
  const run = (user: { email_verified_at: string | null }, accept = 'text/html') =>
    new Verified(router).handle(
      { user: { ...ada, ...user }, expectsJson: () => accept.includes('json') } as never,
      async () => new Response('ok'),
    );

  it('lets verified users through, sends others to the notice (403 for JSON)', async () => {
    expect((await run({ email_verified_at: '2026-10-01T00:00:00.000Z' })).status).toBe(200);
    const away = await run({ email_verified_at: null });
    expect([away.status, away.headers.get('location')]).toEqual([302, '/email/verify']);
    expect((await run({ email_verified_at: null }, 'application/json')).status).toBe(403);
  });

  it('counter-check: a user without the column (a provider that did not select it) is not verified — fail closed', async () => {
    expect((await run({ email_verified_at: undefined as never })).status).toBe(302);
    expect((await run({ email_verified_at: undefined as never }, 'application/json')).status).toBe(403);
  });
});

// --- Type guarantees (never called) -----------------------------------------------------------

export function verifiedTypes() {
  defineRoutes((Route) => {
    // @ts-expect-error — verified() needs the user: authenticate() first
    Route.middleware(verified());
    // @ts-expect-error — the package's test user type (AuthTypes in auth.test.ts) has no email_verified_at
    Route.middleware(authenticate()).middleware(verified());
  });
}

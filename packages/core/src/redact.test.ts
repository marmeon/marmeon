import { describe, expect, it } from 'vitest';
import { ENCRYPTED, MAX_ENTRY_BYTES, REDACTED, Redactor, redactText } from './redact.ts';

const HASH = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaA';
const SCRYPT = '$scrypt$ln=15,r=8,p=1$c2FsdA$aGFzaA';
const TOKEN = 'bc_12|q8Fz0kZb3T5wYvLp9nR2xCj7mHs4dGa1eKoU6iQt0f3c7a9e1';

describe('redactText (E125)', () => {
  it('masks password hashes and API tokens wherever they appear', () => {
    expect(redactText(`hash ${HASH} and ${SCRYPT}.`)).toBe('hash [redacted] and [redacted].');
    expect(redactText(`Authorization failed for ${TOKEN}`)).toBe('Authorization failed for bc_12|[redacted]');
    // Under another prefix too (AUTH_TOKEN_PREFIX).
    expect(redactText(`acme_7|${'a'.repeat(40)}x`)).toBe('acme_7|[redacted]');
    expect(redactText(`password_hash: ${HASH}`)).toBe('password_hash: [redacted]');
  });
});

describe('Redactor (E125)', () => {
  it('replaces sensitive keys at any depth — cookies, set-cookie, x-xsrf-token, _token, password, authorization — and the names added', () => {
    const redactor = new Redactor().addKeys('bespoke_session');
    const value = redactor.value({
      email: 'ada@example.com',
      password: 'hunter2',
      _token: 'csrf-1',
      nested: { headers: { 'set-cookie': 'a=b', 'x-xsrf-token': 'x', authorization: 'Bearer abc' }, list: [{ new_password: 'p' }] },
      bespoke_session: 's3ss10n',
      note: `bespoke_session=s3ss10n; theme=dark`,
    });
    expect(value).toEqual({
      email: 'ada@example.com',
      password: REDACTED,
      _token: REDACTED,
      nested: { headers: { 'set-cookie': REDACTED, 'x-xsrf-token': REDACTED, authorization: REDACTED }, list: [{ new_password: REDACTED }] },
      bespoke_session: REDACTED,
      note: 'bespoke_session=[redacted]; theme=dark',
    });
    expect(JSON.stringify(value)).not.toMatch(/hunter2|csrf-1|s3ss10n|Bearer abc/);
  });

  it('shows files and bytes only by their size, errors by name, message and stack — plain data out', () => {
    const redactor = new Redactor();
    const shown = redactor.value({
      avatar: new File(['12345'], 'me.png', { type: 'image/png' }),
      bytes: new Uint8Array(3),
      when: new Date('2026-10-03T12:00:00Z'),
      failure: new Error(`login failed with password=hunter2 for ${TOKEN}`),
      big: 10n,
    }) as Record<string, unknown>;
    expect(shown.avatar).toBe('[file me.png, 5 bytes, image/png]');
    expect(shown.bytes).toBe('[3 bytes]');
    expect(shown.when).toBe('2026-10-03T12:00:00.000Z');
    expect(shown.failure).toMatchObject({ name: 'Error', message: 'login failed with password=[redacted] for bc_12|[redacted]' });
    expect(shown.big).toBe('10');
  });

  it('redacts headers by name and statements touching secret columns completely', () => {
    const redactor = new Redactor().addKeys('bespoke_session');
    expect(redactor.headers(new Headers({ cookie: 'bespoke_session=abc', authorization: 'Basic eDp5', accept: 'text/html', 'x-xsrf-token': 't' }))).toEqual({
      accept: 'text/html',
      authorization: REDACTED,
      cookie: REDACTED,
      'x-xsrf-token': REDACTED,
    });
    expect(redactor.query({ sql: 'select * from users where email = ?', parameters: ['ada@example.com'], secret: false })).toEqual({
      sql: 'select * from users where email = ?',
      parameters: ['ada@example.com'],
    });
    expect(redactor.query({ sql: 'update users set password = ? where id = ?', parameters: [HASH, 7], secret: true })).toEqual({
      sql: 'update users set password = ? where id = ?',
      parameters: [REDACTED, REDACTED],
    });
    // Without `secret`, a hash or a token among the parameters is still masked.
    expect(redactor.query({ sql: 'insert into log (line) values (?)', parameters: [`token ${TOKEN}`, HASH], secret: false }).parameters).toEqual(['token bc_12|[redacted]', REDACTED]);
  });

  it('cuts every string at 64 KB', () => {
    const shown = new Redactor().text('x'.repeat(MAX_ENTRY_BYTES + 10));
    expect(shown.length).toBeLessThan(MAX_ENTRY_BYTES + 60);
    expect(shown).toMatch(/… \[cut: 10 more characters\]$/);
  });
});

describe('E125, completed for the devtools (W7.7)', () => {
  const token = 'Xq3v9Lr2_pK8sT1uW4yZ6bN0cM5dF7gH-jA2eR9tY1u';

  it('masks token-like path segments — a reset link in a mail, a log line, a Referer — but not slugs, words or ids', () => {
    expect(redactText(`Reset: http://localhost/reset-password/${token}?email=ada%40example.com`)).toBe('Reset: http://localhost/reset-password/[redacted]?email=ada%40example.com');
    expect(redactText(`GET /reset-password/${token} 200`)).toBe('GET /reset-password/[redacted] 200');
    // A hash in a signed link's path (hex).
    expect(redactText('/verify-email/7/2f9a6b1c0d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a')).toBe('/verify-email/7/[redacted]');
    for (const kept of ['/posts/my-very-long-article-title-about-redaction-2026', '/notifications/550e8400-e29b-41d4-a716-446655440000', '/users/7/profile', '/assets/index-BQx7aN2c.js']) {
      expect(redactText(kept)).toBe(kept);
    }
  });

  it('shows encrypted payloads only as [encrypted]', () => {
    const redactor = new Redactor();
    expect(redactor.payload({ code: 'secret-code', password: 'x' }, true)).toBe(ENCRYPTED);
    expect(redactor.payload({ userId: 7, password: 'x' }, false)).toEqual({ userId: 7, password: REDACTED });
  });

  it('redacts sensitive route parameters by the route pattern, and query values by key', () => {
    const redactor = new Redactor();
    expect(redactor.path('/reset/abc', '/reset/:token')).toBe('/reset/[redacted]');
    expect(redactor.path('/users/7', '/users/:user')).toBe('/users/7');
    expect(redactor.path(`/reset-password/${token}`)).toBe('/reset-password/[redacted]');
    expect(redactor.url('http://localhost/reset/abc?email=a%40b.c&token=t0k3n&page=2', '/reset/:token')).toBe('http://localhost/reset/[redacted]?email=a%40b.c&token=[redacted]&page=2');
    expect(redactor.url('/search?q=hello')).toBe('/search?q=hello');
  });

  it('fits a value into 64 KB of JSON — long strings and lists first, a preview at last', () => {
    const redactor = new Redactor();
    const small = { a: 1, b: 'two' };
    expect(redactor.fit(small)).toBe(small);
    const fitted = redactor.fit({ html: 'h'.repeat(100_000), text: 't'.repeat(100_000), rows: Array.from({ length: 5000 }, (_, i) => i) });
    expect(Buffer.byteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(MAX_ENTRY_BYTES);
    expect((fitted as { html: string }).html).toMatch(/^h{8192}… \[cut: 91808 more characters\]$/);
    const huge = redactor.fit(Object.fromEntries(Array.from({ length: 20_000 }, (_, i) => [`key${i}`, i])));
    expect(Buffer.byteLength(JSON.stringify(huge))).toBeLessThanOrEqual(MAX_ENTRY_BYTES);
    expect(huge).toMatchObject({ cut: expect.stringMatching(/bytes$/) });
  });
});

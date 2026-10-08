import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { describeError, ENCRYPTED, MAX_ENTRY_BYTES, redact, REDACTED, Redactor, redactText } from './redact.ts';

const HASH = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaA';
const SCRYPT = '$scrypt$ln=15,r=8,p=1$c2FsdA$aGFzaA';
const TOKEN = 'marmeon_12|q8Fz0kZb3T5wYvLp9nR2xCj7mHs4dGa1eKoU6iQt0f3c7a9e1';

describe('redactText (E125)', () => {
  it('masks password hashes and API tokens wherever they appear', () => {
    expect(redactText(`hash ${HASH} and ${SCRYPT}.`)).toBe('hash [redacted] and [redacted].');
    expect(redactText(`Authorization failed for ${TOKEN}`)).toBe('Authorization failed for marmeon_12|[redacted]');
    // Under another prefix too (AUTH_TOKEN_PREFIX).
    expect(redactText(`acme_7|${'a'.repeat(40)}x`)).toBe('acme_7|[redacted]');
    expect(redactText(`password_hash: ${HASH}`)).toBe('password_hash: [redacted]');
  });
});

describe('Redactor (E125)', () => {
  it('replaces sensitive keys at any depth — cookies, set-cookie, x-xsrf-token, _token, password, authorization — and the names added', () => {
    const redactor = new Redactor().addKeys('marmeon_session');
    const value = redactor.value({
      email: 'ada@example.com',
      password: 'hunter2',
      _token: 'csrf-1',
      nested: { headers: { 'set-cookie': 'a=b', 'x-xsrf-token': 'x', authorization: 'Bearer abc' }, list: [{ new_password: 'p' }] },
      marmeon_session: 's3ss10n',
      note: `marmeon_session=s3ss10n; theme=dark`,
    });
    expect(value).toEqual({
      email: 'ada@example.com',
      password: REDACTED,
      _token: REDACTED,
      nested: { headers: { 'set-cookie': REDACTED, 'x-xsrf-token': REDACTED, authorization: REDACTED }, list: [{ new_password: REDACTED }] },
      marmeon_session: REDACTED,
      note: 'marmeon_session=[redacted]; theme=dark',
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
    expect(shown.failure).toMatchObject({ name: 'Error', message: 'login failed with password=[redacted] for marmeon_12|[redacted]' });
    expect(shown.big).toBe('10');
  });

  it('redacts headers by name and statements touching secret columns completely', () => {
    const redactor = new Redactor().addKeys('marmeon_session');
    expect(redactor.headers(new Headers({ cookie: 'marmeon_session=abc', authorization: 'Basic eDp5', accept: 'text/html', 'x-xsrf-token': 't' }))).toEqual({
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
    expect(redactor.query({ sql: 'insert into log (line) values (?)', parameters: [`token ${TOKEN}`, HASH], secret: false }).parameters).toEqual(['token marmeon_12|[redacted]', REDACTED]);
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

  it('masks every long random token — one without a digit, one with many - and _ (W10 step 9c, finding R) — never a lower-case slug', () => {
    // Two reset tokens (32 random bytes, base64url) the rule before let through: about 1 in 370 was (a digit and few separators were asked).
    const noDigit = 'xcTSGsRRdFsBwbUDGMbH_yNyUBMgdklqlolrXjzXiiI';
    const separators = '-RHB_4z_ytbJPF7qzYPGUQq_an-dByze2Kb-EN8Rp_o';
    for (const secret of [noDigit, separators]) {
      expect(redactText(`Reset: http://localhost/reset-password/${secret}?email=ada%40example.com`), secret).toBe('Reset: http://localhost/reset-password/[redacted]?email=ada%40example.com');
      expect(new Redactor().path(`/email/change/7/${secret}`), secret).toBe('/email/change/7/[redacted]');
    }
    // Every random token of a thousand: the length alone decides, not luck.
    for (let i = 0; i < 1000; i++) {
      const random = randomBytes(32).toString('base64url');
      expect(redactText(`/reset-password/${random}`), random).toBe('/reset-password/[redacted]');
    }
    // What stays: slugs (lower case, also with many separators), words and shorter names in both cases.
    for (const kept of ['/posts/a-b-c-d-e-f-g-h-i-j-k-l-m-n-o-p-q-r-s-t-u-v-w', '/posts/my_long_article_title_about_redaction_twenty', '/wiki/TheQuickBrownFoxJumpsOverTheLazyDog']) {
      expect(redactText(kept), kept).toBe(kept);
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

describe('redact() — the log path, completed (W7.11)', () => {
  it('redacts inside lists, nested lists, maps and sets', () => {
    const shown = redact({
      users: [{ email: 'ada@example.com', password: 'hunter2' }, [{ api_key: 'k-1' }]],
      sessions: new Map<string, unknown>([['token', 't0k3n'], ['owner', { remember_web: 'sel.val' }]]),
      tags: new Set([{ secret: 's' }, 'plain']),
      when: new Date('2026-10-04T12:00:00Z'),
    });
    expect(shown).toEqual({
      users: [{ email: 'ada@example.com', password: REDACTED }, [{ api_key: REDACTED }]],
      sessions: { token: REDACTED, owner: { remember_web: REDACTED } },
      tags: [{ secret: REDACTED }, 'plain'],
      when: new Date('2026-10-04T12:00:00Z'),
    });
    expect(JSON.stringify(shown)).not.toMatch(/hunter2|k-1|t0k3n|sel\.val|"s"/);
  });

  it('keeps an error an error of its class — message, stack, own fields and every cause redacted', () => {
    class HttpError extends Error {
      override name = 'HttpError';
    }
    const cause = Object.assign(new Error('socket token=y'), { config: { headers: { authorization: 'Basic z' } } });
    const error = Object.assign(new HttpError('auth failed for password=x', { cause }), {
      code: 'EAUTH',
      response: { data: [{ access_token: 'a-1' }] },
    });
    const aggregate = new AggregateError([new Error('one secret=s1')], 'two failed');
    const shown = redact({ err: error, aggregate }) as { err: Error & Record<string, unknown>; aggregate: AggregateError };
    expect(shown.err).toBeInstanceOf(HttpError);
    expect(shown.err.message).toBe('auth failed for password=[redacted]');
    expect(shown.err.stack).toContain('password=[redacted]');
    expect(shown.err).toMatchObject({ name: 'HttpError', code: 'EAUTH', response: { data: [{ access_token: REDACTED }] } });
    expect((shown.err.cause as Error).message).toBe('socket token=[redacted]');
    expect((shown.err.cause as Error & { config: unknown }).config).toEqual({ headers: { authorization: REDACTED } });
    expect(shown.aggregate.errors.map((item: Error) => item.message)).toEqual(['one secret=[redacted]']);
    // The original is untouched.
    expect(error.message).toBe('auth failed for password=x');
    // Whatever serializes it — JSON or a logger's error serializer reading its fields — finds no secret.
    const fields = (value: Error) => JSON.stringify({ ...value, message: value.message, stack: value.stack, cause: String((value.cause as Error).message) });
    expect(fields(shown.err)).not.toMatch(/password=x|token=y|Basic z|a-1/);
  });

  it('survives cycles and leaves out what is nested deeper than six levels', () => {
    const error = new Error('loop') as Error & { self?: unknown };
    error.cause = error;
    const deep = { a: { b: { c: { d: { e: { f: { g: { h: { note: 'deep' } } } } } } } } };
    expect(() => redact({ error })).not.toThrow();
    expect(JSON.stringify(redact(deep))).not.toContain('deep');
  });

  it('describes a non-error cause or a thrown object redacted by key, also inside lists', () => {
    const text = describeError(new Error('failed', { cause: { attempts: [{ token: 'abc' }] } }));
    expect(text).toContain('Caused by: {"attempts":[{"token":"[redacted]"}]}');
    expect(describeError({ users: [{ password: 'hunter2' }] })).not.toContain('hunter2');
  });
});

describe('Redactor.text — the shortcut for text without anything to mask (W7.11)', () => {
  it('returns a plain path as it is, and masks the same as redactText wherever a pattern could match', () => {
    const redactor = new Redactor(['marmeon_session']);
    const token = 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z';
    const texts = [
      '/users/7/edit', '/people', '/lab/errors/table', '/docs/packages/core', '/a-slug-of-thirty-one-characters',
      `/reset-password/${token}`, `/files/${'a'.repeat(31)}b`, '/x?password=hunter2', '/x;password:hunter2',
      'Bearer abc', '$argon2id$v=19$m=1,t=1,p=1$c2FsdA$aGFzaA', 'marmeon_1|' + token, 'postgres://u:secret@host/db',
      'marmeon_session=abc', 'a b',
    ];
    for (const text of texts) {
      const expected = redactText(text).replace(/(\bmarmeon_session)(\s*[:=]\s*"?)([^\s"'&,;}]+)/gi, '$1$2[redacted]');
      expect(redactor.text(text), text).toBe(expected);
    }
    expect(redactor.text('/users/7/edit')).toBe('/users/7/edit');
    expect(redactor.text(`/reset-password/${token}`)).toBe('/reset-password/[redacted]');
    expect(redactor.path(`/reset-password/${token}`)).toBe('/reset-password/[redacted]');
    expect(redactor.text('marmeon_session=abc')).toBe('marmeon_session=[redacted]');
  });
});

describe('Redactor.headers — a header given more than once', () => {
  it('redacts set-cookie as a list and joins other lists', () => {
    const shown = new Redactor().headers({ 'set-cookie': ['a=1', 'b=2'], 'x-forwarded-for': ['1.2.3.4', '5.6.7.8'], accept: 'text/html', missing: undefined });
    expect(shown).toEqual({ 'set-cookie': REDACTED, 'x-forwarded-for': '1.2.3.4, 5.6.7.8', accept: 'text/html' });
  });
});

describe('URL objects (W10 step 8)', () => {
  const RESET = 'Q7mZ2xLk9TcV4bN8rW1yH6sD3fG5jA0pE2uI7oK9qMz';

  it('are masked like text on the log path — a query token and a token-like path segment never pass as the object', () => {
    const link = new URL(`https://example.com/reset-password/${RESET}?email=ada%40example.com&token=t0k3n-abc&page=2`);
    const shown = redact({ link, nested: { at: [new URL('https://example.com/callback?signature=s1gn3d')] }, query: new URLSearchParams('token=t0k3n-abc&page=2') });
    expect(shown.link, String(shown.link)).toBe('https://example.com/reset-password/[redacted]?email=ada%40example.com&token=[redacted]&page=2');
    expect(shown.nested).toEqual({ at: ['https://example.com/callback?signature=[redacted]'] });
    expect(shown.query).toBe('token=[redacted]&page=2');
    expect(JSON.stringify(shown)).not.toMatch(/t0k3n|s1gn3d|Q7mZ2xLk9/);
    // A URL without anything to hide stays readable.
    expect(redact({ link: new URL('https://example.com/users/7?page=2') }).link).toBe('https://example.com/users/7?page=2');
  });

  it('are masked by the Redactor too (devtools, error page, spans) — its URL rules, not an empty object', () => {
    const redactor = new Redactor();
    const shown = redactor.value({ link: new URL(`https://example.com/reset-password/${RESET}?token=t0k3n-abc`), query: new URLSearchParams('signature=s1gn3d') }) as Record<string, unknown>;
    expect(shown.link).toBe('https://example.com/reset-password/[redacted]?token=[redacted]');
    expect(shown.query).toBe('signature=[redacted]');
  });
});

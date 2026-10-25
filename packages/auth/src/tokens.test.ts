import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { crc32 } from 'node:zlib';
import { SystemClock } from '@marmeon/core';
import { secret as secretColumn, type Connections } from '@marmeon/database';
import type { HttpContext } from '@marmeon/http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { drivers, migratedConnections } from './__fixtures__/databases.ts';
import { abilities, authenticate } from './middleware.ts';
import { ACCESS_TOKEN_TABLE, DatabaseAccessTokens, hashToken, parseAccessToken, tokenCan, type AccessTokenTable, type WithToken } from './tokens.ts';
import type { AuthUserId } from './user.ts';
import { openRoutes } from './test-helpers/open-routes.ts';

const checksumOf = (value: string) => crc32(value).toString(16).padStart(8, '0');

describe.each(drivers)('API tokens on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  let tokens: DatabaseAccessTokens;
  const queries: string[] = [];

  beforeAll(async () => {
    ({ connections, close } = await migratedConnections(driver));
    tokens = new DatabaseAccessTokens(connections, { tokenPrefix: 'marmeon_' } as never, new SystemClock());
    connections.onQuery((query) => queries.push(query.sql));
  });
  afterAll(() => close());
  beforeEach(() => connections.get<any>().deleteFrom(ACCESS_TOKEN_TABLE).execute());
  afterEach(() => vi.useRealTimers());

  it('hands out marmeon_<40 characters><crc32> once — the database keeps only a hash of the secret under a prefix of its own', async () => {
    const { plainText, token } = await tokens.create(1, 'CLI', { abilities: ['users:read'] });
    expect(plainText).toMatch(/^marmeon_[A-Za-z0-9]{40}[0-9a-f]{8}$/);
    expect(plainText).not.toContain('|');
    expect(token).toMatchObject({ userId: 1, name: 'CLI', abilities: ['users:read'], lastUsedAt: null, expiresAt: null });
    const secret = plainText.slice('marmeon_'.length, -8);
    const stored = JSON.stringify(await connections.get<{ [ACCESS_TOKEN_TABLE]: AccessTokenTable }>().selectFrom(ACCESS_TOKEN_TABLE).selectAll().select((eb) => secretColumn(eb, 'token_hash')).execute());
    expect(stored).not.toContain(secret);
    expect(stored).toContain(hashToken(secret));
    expect(hashToken(secret)).not.toBe(createHash('sha256').update(secret).digest('base64url'));
    expect(await tokens.find(plainText)).toMatchObject({ id: token.id, userId: 1, abilities: ['users:read'] });
  });

  it('expires in a duration object as in seconds, rounded down, and refuses a string', async () => {
    const days = await tokens.create(1, 'ninety days', { expiresIn: { days: 90 } });
    const seconds = await tokens.create(1, 'the same', { expiresIn: 90 * 86_400 });
    const spread = Math.abs(new Date(days.token.expiresAt!).getTime() - new Date(seconds.token.expiresAt!).getTime());
    expect(spread).toBeLessThan(2000);
    expect(new Date(days.token.expiresAt!).getTime() - Date.now()).toBeGreaterThan(90 * 86_400_000 - 2000);
    expect(new Date(days.token.expiresAt!).getTime() - Date.now()).toBeLessThanOrEqual(90 * 86_400_000);
    const before = (await tokens.list(1)).length;
    await expect(tokens.create(1, 'text', { expiresIn: '90d' as never })).rejects.toThrow('write `{ days: 90 }`');
    expect((await tokens.list(1)).length).toBe(before);
  });

  it('authenticates every token of the fixtures, in the directory', async () => {
    const directory = new URL('./__fixtures__/formats/access-token/', import.meta.url);
    const files = readdirSync(directory).filter((file) => file.endsWith('.json'));
    expect(files).toContain('v2.json');
    for (const file of files) {
      const fixture = JSON.parse(readFileSync(new URL(file, directory), 'utf8')) as { prefix: string; plainText: string; row: Record<string, unknown> };
      await connections.get<any>().deleteFrom(ACCESS_TOKEN_TABLE).execute();
      await connections.get<any>().insertInto(ACCESS_TOKEN_TABLE).values({ ...fixture.row, abilities: JSON.stringify(fixture.row.abilities) }).execute();
      const reader = new DatabaseAccessTokens(connections, { tokenPrefix: fixture.prefix } as never, new SystemClock());
      expect(await reader.find(fixture.plainText), file).toMatchObject({ userId: 1, name: 'Fixture', abilities: ['users:read'] });
    }
  });

  const lookups = () => queries.filter((sql) => /token_hash/.test(sql));

  it('a token of the first form, a wrong checksum, a wrong length and an unknown token all run the same one query and get the same answer', async () => {
    const { plainText } = await tokens.create(1, 'CLI');
    const secret = plainText.slice('marmeon_'.length, -8);
    const typo = plainText.slice(0, 10) + (plainText[10] === 'a' ? 'b' : 'a') + plainText.slice(11);
    const unknown = `marmeon_${'A'.repeat(40)}${checksumOf(`marmeon_${'A'.repeat(40)}`)}`;
    const presented = [
      unknown,
      `marmeon_12|${secret}${checksumOf(`marmeon_12|${secret}`)}`, // the first release's form
      typo,
      plainText.slice(0, -1), // one character short
      `${plainText}x`,
      `marmeon_${secret}`, // no checksum
      'marmeon_1|short',
      'marmeon_',
    ];
    const shapes = new Set<string>();
    for (const value of presented) {
      queries.length = 0;
      expect(await tokens.find(value), value).toBeUndefined();
      expect(lookups(), value).toHaveLength(1);
      expect(queries, value).toHaveLength(1);
      shapes.add(queries[0]!);
    }
    expect(shapes.size, 'the same statement every time').toBe(1);
    expect(await tokens.find(plainText)).toBeDefined();
  });

  it('with an empty prefix, the bare secret is no token, and costs the same one query', async () => {
    const bare = new DatabaseAccessTokens(connections, { tokenPrefix: '' } as never, new SystemClock());
    const { plainText } = await bare.create(1, 'CLI');
    expect(plainText).toMatch(/^[A-Za-z0-9]{48}$/);
    expect(await bare.find(plainText)).toBeDefined();
    const secret = plainText.slice(0, 40);
    for (const presented of [secret, `${secret}00000000`, plainText.slice(0, 47)]) {
      queries.length = 0;
      expect(await bare.find(presented), presented).toBeUndefined();
      expect(lookups()).toHaveLength(1);
    }
  });

  it('a string without the app’s prefix costs no query', async () => {
    const { plainText } = await tokens.create(1, 'CLI');
    queries.length = 0;
    for (const presented of [plainText.replace('marmeon_', 'gh_'), '', 'Bearer x', 'marmeon', 'MARMEON_x']) {
      expect(await tokens.find(presented), presented).toBeUndefined();
    }
    expect(queries).toEqual([]);
    expect(parseAccessToken(plainText, 'marmeon_')).toBeDefined();
    expect(parseAccessToken(plainText, 'other_')).toBeUndefined();
  });

  it('a secret of the first release, repacked as the new form, finds nothing — even with its row in the table', async () => {
    const secret = 'Zx9kQ2mV7bN4cL1hG8jF5dS3aP6oI0uYtRwEeWqM'.slice(0, 40);
    expect(secret).toHaveLength(40);
    // The first release stored a plain SHA-256 of the secret.
    await connections.get<any>().insertInto(ACCESS_TOKEN_TABLE).values({ user_id: 1, name: 'old', token_hash: createHash('sha256').update(secret).digest('base64url'), abilities: '["*"]', last_used_at: null, expires_at: null, created_at: new Date(), updated_at: new Date() }).execute();
    const repacked = `marmeon_${secret}${checksumOf(`marmeon_${secret}`)}`;
    expect(parseAccessToken(repacked, 'marmeon_'), 'the shape alone is fine').toBeDefined();
    expect(await tokens.find(repacked)).toBeUndefined();
    expect(await tokens.find(`marmeon_7|${secret}${checksumOf(`marmeon_7|${secret}`)}`)).toBeUndefined();
  });

  it('refuses an expired token whose hash matches, and does not tell it from an unknown one', async () => {
    const expiring = await tokens.create(1, 'short', { expiresIn: { hours: 1 } });
    expect(await tokens.find(expiring.plainText)).toBeDefined();
    await connections.get<any>().updateTable(ACCESS_TOKEN_TABLE).set({ expires_at: new Date(Date.now() - 1000) }).execute();
    queries.length = 0;
    expect(await tokens.find(expiring.plainText)).toBeUndefined();
    expect(lookups()).toHaveLength(1);
  });

  it('refuses two rows with one hash', async () => {
    const { plainText } = await tokens.create(1, 'CLI');
    const secret = plainText.slice('marmeon_'.length, -8);
    const now = new Date();
    await expect(
      connections.get<any>().insertInto(ACCESS_TOKEN_TABLE).values({ user_id: 2, name: 'copy', token_hash: hashToken(secret), abilities: '["*"]', last_used_at: null, expires_at: null, created_at: now, updated_at: now }).execute(),
    ).rejects.toThrow();
  });

  it('refuses expired and revoked tokens; revokes only the user’s own', async () => {
    const expiring = await tokens.create(1, 'short', { expiresIn: { hours: 1 } });
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 3_601_000 });
    expect(await tokens.find(expiring.plainText)).toBeUndefined();
    vi.useRealTimers();
    const { plainText, token } = await tokens.create(1, 'CLI');
    expect(await tokens.revoke(2, token.id)).toBe(false); // someone else's
    expect(await tokens.find(plainText)).toBeDefined();
    expect(await tokens.revoke(1, token.id)).toBe(true);
    expect(await tokens.find(plainText)).toBeUndefined();
    expect((await tokens.list(1)).map((listed) => listed.name)).toEqual(['short']);
  });

  it('gives the id as a string on a table with UUID keys', async () => {
    const own = await migratedConnections(driver, new URL('./__fixtures__/uuid-migrations/', import.meta.url));
    try {
      const store = new DatabaseAccessTokens(own.connections, { tokenPrefix: 'marmeon_' } as never, new SystemClock());
      const owner = '11111111-1111-4111-8111-111111111111' as unknown as AuthUserId;
      const { plainText, token } = await store.create(owner, 'CLI');
      expect(typeof token.id).toBe('string');
      expect((await store.find(plainText))!.id).toBe(token.id);
      expect(await store.revoke(owner, token.id)).toBe(true);
      expect(await store.find(plainText)).toBeUndefined();
    } finally {
      await own.close();
    }
  });

  it('notes the last use at most once a minute', async () => {
    const { plainText } = await tokens.create(1, 'CLI');
    const first = (await tokens.find(plainText))!;
    queries.length = 0;
    await tokens.touch(first);
    const second = (await tokens.find(plainText))!;
    expect(second.lastUsedAt).toMatch(/Z$/);
    await tokens.touch(second); // within a minute: no write
    expect(queries.filter((sql) => /^update/i.test(sql))).toHaveLength(1);
  });

  it('checks abilities — * grants everything', () => {
    const token = { abilities: ['users:read'] } as never;
    expect(tokenCan(token, 'users:read')).toBe(true);
    expect(tokenCan(token, 'users:write')).toBe(false);
    expect(tokenCan({ abilities: ['*'] } as never, 'anything')).toBe(true);
  });
});

// --- Type guarantees (never called) -----------------------------------------------------------

export function tokenTypes() {
  openRoutes((Route) => {
    Route.middleware(authenticate('api')).middleware(abilities('users:read')).get('/users', (ctx) => ({ id: ctx.user.id, abilities: ctx.token.abilities }));
    // @ts-expect-error — abilities() needs the token: authenticate('api') first
    Route.middleware(abilities('users:read'));
    // @ts-expect-error — a session has no token: abilities() after authenticate() (web) is a mistake
    Route.middleware(authenticate()).middleware(abilities('users:read'));
    // @ts-expect-error — the session guard adds no token
    Route.middleware(authenticate()).get('/me', (ctx: HttpContext<WithToken>) => ctx.token.name);
  });
}

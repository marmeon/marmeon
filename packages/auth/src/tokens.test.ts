import { SystemClock } from '@marmeon/core';
import type { Connections } from '@marmeon/database';
import { defineRoutes, type HttpContext } from '@marmeon/http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { drivers, migratedConnections } from './__fixtures__/databases.ts';
import { abilities, authenticate } from './middleware.ts';
import { ACCESS_TOKEN_TABLE, DatabaseAccessTokens, parseAccessToken, tokenCan, type WithToken } from './tokens.ts';

describe.each(drivers)('API tokens on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  let tokens: DatabaseAccessTokens;
  const queries: string[] = [];

  beforeAll(async () => {
    ({ connections, close } = await migratedConnections(driver));
    tokens = new DatabaseAccessTokens(connections, { tokenPrefix: 'bc_' } as never, new SystemClock());
    connections.onQuery((query) => queries.push(query.sql));
  });
  afterAll(() => close());
  beforeEach(() => connections.get<any>().deleteFrom(ACCESS_TOKEN_TABLE).execute());
  afterEach(() => vi.useRealTimers());

  it('hands out bc_<id>|<40 characters><crc32> once — the database keeps only a hash of the secret', async () => {
    const { plainText, token } = await tokens.create(1, 'CLI', { abilities: ['users:read'] });
    expect(plainText).toMatch(new RegExp(`^bc_${token.id}\\|[A-Za-z0-9]{40}[0-9a-f]{8}$`));
    expect(token).toMatchObject({ userId: 1, name: 'CLI', abilities: ['users:read'], lastUsedAt: null, expiresAt: null });
    const secret = plainText.split('|')[1]!.slice(0, 40);
    expect(JSON.stringify(await connections.get<any>().selectFrom(ACCESS_TOKEN_TABLE).selectAll().select('token_hash').execute())).not.toContain(secret);
    expect(await tokens.find(plainText)).toMatchObject({ id: token.id, userId: 1, abilities: ['users:read'] });
  });

  it('counter-check: a broken checksum, a wrong prefix or garbage cost no query', async () => {
    const { plainText } = await tokens.create(1, 'CLI');
    const typo = plainText.slice(0, 10) + (plainText[10] === 'a' ? 'b' : 'a') + plainText.slice(11);
    queries.length = 0;
    for (const presented of [typo, plainText.replace('bc_', 'gh_'), `${plainText}x`, 'bc_1|short', '', 'Bearer x']) {
      expect(await tokens.find(presented), presented).toBeUndefined();
    }
    expect(queries).toEqual([]);
    expect(parseAccessToken(plainText, 'bc_')).toBeDefined();
  });

  it('counter-check: the right id with a wrong secret (another user’s token id) is no token', async () => {
    const { token } = await tokens.create(2, 'Alan’s');
    const forged = `bc_${token.id}|${'A'.repeat(40)}`;
    const { crc32 } = await import('node:zlib');
    const withChecksum = `${forged}${crc32(forged).toString(16).padStart(8, '0')}`; // passes the checksum, not the hash
    expect(parseAccessToken(withChecksum, 'bc_')).toBeDefined();
    expect(await tokens.find(withChecksum)).toBeUndefined();
  });

  it('refuses expired and revoked tokens; revokes only the user’s own', async () => {
    const expiring = await tokens.create(1, 'short', { expiresIn: '1h' });
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
  defineRoutes((Route) => {
    Route.middleware(authenticate('api')).middleware(abilities('users:read')).get('/users', (ctx) => ({ id: ctx.user.id, abilities: ctx.token.abilities }));
    // @ts-expect-error — abilities() needs the token: authenticate('api') first
    Route.middleware(abilities('users:read'));
    // @ts-expect-error — a session has no token: abilities() after authenticate() (web) is a mistake
    Route.middleware(authenticate()).middleware(abilities('users:read'));
    // @ts-expect-error — the session guard adds no token
    Route.middleware(authenticate()).get('/me', (ctx: HttpContext<WithToken>) => ctx.token.name);
  });
}

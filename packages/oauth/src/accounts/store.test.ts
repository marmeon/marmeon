import { TestClock } from '@marmeon/core/testing';
import { secret, sql, type Connections } from '@marmeon/database';
import { AesGcmEncrypter, DecryptError, generateKey } from '@marmeon/encryption';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drivers, migratedConnections } from '../__fixtures__/databases.ts';
import type { SocialUser } from '../definition.ts';
import { SOCIAL_ACCOUNT_COLUMNS, SocialAccountStore, type SocialAccountTable } from './store.ts';

const TOKEN = ['access', 'token', 'value'].join('-');
const REFRESH = ['refresh', 'token', 'value'].join('-');
const EXPIRES = Date.parse('2030-01-01T00:00:00Z');

type Key = ReturnType<typeof randomKey>;
function randomKey() {
  return new Uint8Array(Buffer.from(generateKey().replace('base64:', ''), 'base64'));
}

function socialUser(overrides: Partial<SocialUser> = {}): SocialUser {
  return {
    provider: 'github',
    id: 'gh-1',
    email: 'ada@example.com',
    emailVerified: true,
    name: 'Ada',
    nickname: 'ada',
    avatar: null,
    raw: {},
    tokens: { accessToken: TOKEN, refreshToken: REFRESH, expiresAt: EXPIRES, scopes: ['read:user', 'user:email'] },
    ...overrides,
  };
}

describe.each(drivers)('SocialAccountStore on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  const encrypter = new AesGcmEncrypter(Buffer.from(generateKey().replace('base64:', ''), 'base64'));
  const clock = new TestClock();
  const storeWith = (storeTokens: boolean) => new SocialAccountStore(connections, clock, encrypter, { registration: true, storeTokens });
  let store: SocialAccountStore;
  const db = () => connections.get<{ social_accounts: SocialAccountTable }>();
  // A select-all leaves the secret columns out; the test asks for them, as the store does.
  const rows = () =>
    db()
      .selectFrom('social_accounts')
      .select((eb) => ['id', 'user_id', 'provider', 'provider_id', 'email', 'nickname', secret(eb, 'access_token'), secret(eb, 'refresh_token'), 'token_expires_at', 'scopes', 'last_used_at', 'created_at', 'updated_at'])
      .orderBy('id')
      .execute();
  const noTokens = { access_token: null, refresh_token: null, token_expires_at: null, scopes: null };

  beforeAll(async () => {
    ({ connections, close } = await migratedConnections(driver));
  });
  afterAll(() => close());
  beforeEach(async () => {
    clock.travelTo(Date.now());
    await connections.get<any>().deleteFrom('social_accounts').execute();
    await connections.get<any>().deleteFrom('users').execute();
    for (const id of [1, 2]) await connections.get<any>().insertInto('users').values({ id }).execute();
    store = storeWith(false);
  });
  async function created(userId: number, user = socialUser(), using = store) {
    const result = await using.create(userId, user);
    if (!result.ok) throw new Error(result.error.kind);
    return result.value;
  }

  it('creates an account and finds it by provider and provider id', async () => {
    const record = await created(1);
    expect(record).toMatchObject({ userId: 1, provider: 'github', providerId: 'gh-1', email: 'ada@example.com', nickname: 'ada' });
    expect(record.lastUsedAt).toBeInstanceOf(Date);
    expect(await store.find('github', 'gh-1')).toEqual(record);
    expect(await store.find('github', 'gh-2')).toBeUndefined();
    expect(await store.find('gitlab', 'gh-1')).toBeUndefined();
    expect(await store.forUser(1)).toEqual([record]);
    expect(await store.forUser(2)).toEqual([]);
  });

  it('lists the accounts of a user oldest first, and moves lastUsedAt on touch', async () => {
    // Created in an order that differs from the alphabet, so neither the name nor a lucky scan order can pass for the insertion order.
    const first = await created(1, socialUser({ provider: 'gitlab', id: 'gl-1' }));
    const second = await created(1);
    expect((await store.forUser(1)).map((record) => record.provider)).toEqual(['gitlab', 'github']);
    clock.travel(3600);
    expect(await store.touch(first.id, socialUser({ provider: 'gitlab', id: 'gl-1' }))).toBe(true);
    const [touched, untouched] = await store.forUser(1);
    expect(touched!.lastUsedAt!.getTime() - first.lastUsedAt!.getTime()).toBeGreaterThanOrEqual(3_600_000 - 1000);
    expect(untouched!.lastUsedAt).toEqual(second.lastUsedAt);
    expect((await store.forUser(1)).map((record) => record.provider)).toEqual(['gitlab', 'github']);
  });

  it('refuses a provider account that another user holds (taken) and never moves it', async () => {
    const first = await created(1);
    expect(await store.create(2, socialUser({ email: 'mallory@example.com' }))).toMatchObject({ ok: false, error: { kind: 'taken' } });
    expect(await store.create(1, socialUser())).toMatchObject({ ok: false, error: { kind: 'taken' } });
    expect(await store.find('github', 'gh-1')).toEqual(first);
    expect(await store.forUser(2)).toEqual([]);
    expect((await rows()).map((row) => Number(row.user_id))).toEqual([1]);
  });

  it('refuses a second account of one provider for one user (provider-linked)', async () => {
    await created(1);
    expect(await store.create(1, socialUser({ id: 'gh-2' }))).toMatchObject({ ok: false, error: { kind: 'provider-linked' } });
    expect(await store.find('github', 'gh-2')).toBeUndefined();
    // Another provider, and the same provider for another user, are fine.
    expect((await store.create(1, socialUser({ provider: 'gitlab' }))).ok).toBe(true);
    expect((await store.create(2, socialUser({ id: 'gh-2' }))).ok).toBe(true);
  });

  it('throws a TypeError for an empty provider or id, or an id over 255 characters, and never cuts it', async () => {
    const longest = 'x'.repeat(255);
    expect((await store.create(1, socialUser({ id: longest }))).ok).toBe(true);
    expect((await store.find('github', longest))?.providerId).toBe(longest);
    for (const bad of [socialUser({ provider: '' }), socialUser({ id: '' }), socialUser({ id: 'x'.repeat(256) }), socialUser({ id: 7 as unknown as string })]) {
      await expect(store.create(2, bad)).rejects.toThrow(TypeError);
      await expect(store.touch(1, bad)).rejects.toThrow(TypeError);
      await expect(store.find(bad.provider, bad.id)).rejects.toThrow(TypeError);
    }
    expect(await store.forUser(2)).toEqual([]);
  });

  it('keeps a long e-mail address and nickname, which the provider decides', async () => {
    const nickname = 'n'.repeat(300);
    const email = `${'e'.repeat(300)}@example.com`;
    const record = await created(1, socialUser({ nickname, email }));
    expect(record).toMatchObject({ nickname, email });
    expect(await store.find('github', 'gh-1')).toMatchObject({ nickname, email });
  });

  it('stores no tokens unless OAUTH_STORE_TOKENS is on, and clears stored ones on the next touch once it is off', async () => {
    const record = await created(1);
    expect(await rows()).toMatchObject([noTokens]);
    expect(await store.tokens(1, 'github')).toBeUndefined();

    const storing = storeWith(true);
    await storing.touch(record.id, socialUser());
    expect(await storing.tokens(1, 'github')).toEqual({ accessToken: TOKEN, refreshToken: REFRESH, expiresAt: EXPIRES, scopes: ['read:user', 'user:email'] });

    await store.touch(record.id, socialUser());
    expect(await rows()).toMatchObject([noTokens]);
    expect(await storing.tokens(1, 'github')).toBeUndefined();
  });

  it('reads no tokens while OAUTH_STORE_TOKENS is off, even when the row holds some', async () => {
    const storing = storeWith(true);
    await created(1, socialUser(), storing);
    expect(await storing.tokens(1, 'github')).toMatchObject({ accessToken: TOKEN });
    expect((await rows())[0]!.access_token).not.toBeNull();
    // Off again: nothing is decrypted, not even a token the next sign-in has not cleared yet.
    expect(await store.tokens(1, 'github')).toBeUndefined();
  });

  it('keeps the stored refresh token when a sign-in sends none, and clears it with the variable off', async () => {
    const storing = storeWith(true);
    const record = await created(1, socialUser(), storing);
    await storing.touch(record.id, socialUser({ tokens: { accessToken: 'second-access', scopes: ['read:user'] } }));
    expect(await storing.tokens(1, 'github')).toEqual({ accessToken: 'second-access', refreshToken: REFRESH, scopes: ['read:user'] });
    await storing.touch(record.id, socialUser({ tokens: { accessToken: 'third-access', refreshToken: 'new-refresh', scopes: [] } }));
    expect(await storing.tokens(1, 'github')).toMatchObject({ accessToken: 'third-access', refreshToken: 'new-refresh' });
    await store.touch(record.id, socialUser({ tokens: { accessToken: 'fourth', scopes: [] } }));
    expect((await rows())[0]!.refresh_token).toBeNull();
  });

  it('seals a kept refresh token again with the current key, so it outlives the old key', async () => {
    const oldKey = randomKey();
    const newKey = randomKey();
    const sealedWith = (...keys: Key[]) => new SocialAccountStore(connections, clock, new AesGcmEncrypter(keys[0]!, keys.slice(1)), { registration: true, storeTokens: true });
    const record = await created(1, socialUser(), sealedWith(oldKey));
    const rotated = sealedWith(newKey, oldKey);
    expect(await rotated.touch(record.id, socialUser({ tokens: { accessToken: 'fresh-access', scopes: [] } }))).toBe(true);
    // The old key is gone now: the access token was replaced and the refresh token resealed by the touch.
    expect(await sealedWith(newKey).tokens(1, 'github')).toEqual({ accessToken: 'fresh-access', refreshToken: REFRESH, scopes: [] });
  });

  it('leaves a kept refresh token that no longer decrypts as it is, without throwing from touch', async () => {
    const lostKey = randomKey();
    const current = randomKey();
    const sealedWith = (key: Key) => new SocialAccountStore(connections, clock, new AesGcmEncrypter(key), { registration: true, storeTokens: true });
    const record = await created(1, socialUser(), sealedWith(lostKey));
    const before = (await rows())[0]!.refresh_token;
    expect(before).not.toBeNull();
    expect(await sealedWith(current).touch(record.id, socialUser({ tokens: { accessToken: 'fresh-access', scopes: [] } }))).toBe(true);
    expect((await rows())[0]!.refresh_token).toBe(before);
    await expect(sealedWith(current).tokens(1, 'github')).rejects.toThrow(DecryptError);
    // Listing the lost key again brings the account back.
    const relisted = new SocialAccountStore(connections, clock, new AesGcmEncrypter(current, [lostKey]), { registration: true, storeTokens: true });
    expect(await relisted.tokens(1, 'github')).toEqual({ accessToken: 'fresh-access', refreshToken: REFRESH, scopes: [] });
  });

  it('stores tokens encrypted: the column never holds the token, and a ciphertext copied to another row does not decrypt', async () => {
    const storing = storeWith(true);
    await created(1, socialUser(), storing);
    await created(2, socialUser({ id: 'gh-2', tokens: { accessToken: 'other-access', scopes: [] } }), storing);
    expect(await storing.tokens(1, 'github')).toMatchObject({ accessToken: TOKEN, refreshToken: REFRESH });
    expect(await storing.tokens(2, 'github')).toEqual({ accessToken: 'other-access', scopes: [] });
    const [one, two] = await rows();
    expect(one!.access_token).not.toContain(TOKEN);
    expect(one!.refresh_token).not.toContain(REFRESH);
    expect(two!.refresh_token).toBeNull();
    expect(one!.access_token).not.toBe(two!.access_token);

    // Copy the ciphertext of the first row into the second: bound to its own row, it must not decrypt there.
    await sql`update social_accounts set access_token = ${one!.access_token as string} where id = ${two!.id as number}`.execute(connections.get<any>());
    await expect(storing.tokens(2, 'github')).rejects.toThrow(DecryptError);
  });

  it('binds each token to its kind: the access and refresh ciphertext swapped in one row do not decrypt', async () => {
    const storing = storeWith(true);
    await created(1, socialUser(), storing);
    const [row] = await rows();
    await sql`update social_accounts set access_token = ${row!.refresh_token as string}, refresh_token = ${row!.access_token as string} where id = ${row!.id as number}`.execute(connections.get<any>());
    await expect(storing.tokens(1, 'github')).rejects.toThrow(DecryptError);
  });

  it('leaves the token columns out of a select-all', async () => {
    await created(1, socialUser(), storeWith(true));
    const [row] = await db().selectFrom('social_accounts').selectAll().execute();
    expect(Object.keys(row!)).not.toContain('access_token');
    expect(Object.keys(row!)).not.toContain('refresh_token');
    expect(JSON.stringify(row)).not.toContain(TOKEN);
  });

  it('writes nothing for a provider account that is not the one of the row, and says so', async () => {
    const storing = storeWith(true);
    const record = await created(1);
    expect(await storing.touch(record.id, socialUser({ id: 'gh-9', email: 'mallory@example.com', nickname: 'mallory' }))).toBe(false);
    expect(await storing.touch(record.id, socialUser({ provider: 'gitlab', email: 'mallory@example.com' }))).toBe(false);
    expect(await store.find('github', 'gh-1')).toMatchObject({ email: 'ada@example.com', nickname: 'ada' });
    expect(await storing.tokens(1, 'github')).toBeUndefined();
  });

  it('answers false to a touch of an account that was removed', async () => {
    const record = await created(1);
    await store.remove(1, 'github', async () => true);
    expect(await store.touch(record.id, socialUser())).toBe(false);
    expect(await store.forUser(1)).toEqual([]);
  });

  it('removes an account while another social account remains, handing the rest to otherMethod', async () => {
    await created(1);
    const gitlab = await created(1, socialUser({ provider: 'gitlab', id: 'gl-1' }));
    const seen: (readonly unknown[])[] = [];
    const result = await store.remove(1, 'github', async (remaining) => (seen.push(remaining), true));
    expect(result).toMatchObject({ ok: true, value: { provider: 'github', providerId: 'gh-1' } });
    expect(seen).toEqual([[gitlab]]);
    expect((await store.forUser(1)).map((record) => record.provider)).toEqual(['gitlab']);
    expect(await store.remove(1, 'github', async () => true)).toMatchObject({ ok: false, error: { kind: 'not-found' } });
    expect(await store.remove(2, 'gitlab', async () => true)).toMatchObject({ ok: false, error: { kind: 'not-found' } });
    expect(await store.forUser(1)).toHaveLength(1);
  });

  it('rolls the removal back when otherMethod says no for the remaining accounts', async () => {
    await created(1);
    await created(1, socialUser({ provider: 'gitlab', id: 'gl-1' }));
    expect(await store.remove(1, 'github', async (remaining) => remaining.length === 0)).toMatchObject({ ok: false, error: { kind: 'last-method' } });
    expect(await store.forUser(1)).toHaveLength(2);
  });

  it('refuses to remove the last account when otherMethod says no, and leaves the row in place', async () => {
    const record = await created(1);
    let remaining: readonly unknown[] | undefined;
    expect(await store.remove(1, 'github', async (rest) => ((remaining = rest), false))).toMatchObject({ ok: false, error: { kind: 'last-method' } });
    expect(remaining).toEqual([]);
    expect(await store.forUser(1)).toEqual([record]);
    expect(await store.remove(1, 'github', async () => true)).toMatchObject({ ok: true });
    expect(await store.forUser(1)).toEqual([]);
  });

  it('keeps the row when otherMethod throws', async () => {
    const record = await created(1);
    await expect(store.remove(1, 'github', async () => Promise.reject(new Error('lookup failed')))).rejects.toThrow('lookup failed');
    expect(await store.forUser(1)).toEqual([record]);
  });

  it.runIf(driver === 'pgsql')('two parallel removals of the last two accounts leave one', async () => {
    // Several rounds: without the row lock the two transactions only sometimes overlap.
    for (let round = 0; round < 15; round++) {
      await connections.get<any>().deleteFrom('social_accounts').execute();
      await created(1);
      await created(1, socialUser({ provider: 'gitlab', id: 'gl-1' }));
      const results = await Promise.all([store.remove(1, 'github', async (rest) => rest.length > 0), store.remove(1, 'gitlab', async (rest) => rest.length > 0)]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(await store.forUser(1)).toHaveLength(1);
    }
  });

  it('the stub migration creates every column the store reads', async () => {
    const record = await created(1);
    const row = (await rows())[0]!;
    for (const column of SOCIAL_ACCOUNT_COLUMNS) expect(Object.keys(row), column).toContain(column);
    expect(record.id).toBe(Number(row.id));
    expect(await store.touch(record.id, socialUser({ email: null, nickname: 'ada2' }))).toBe(true);
    expect(await store.find('github', 'gh-1')).toMatchObject({ email: null, nickname: 'ada2' });
  });

  it('deletes the accounts of a user with the user', async () => {
    await created(1);
    await created(2, socialUser({ id: 'gh-2' }));
    await connections.get<any>().deleteFrom('users').where('id', '=', 1).execute();
    expect(await store.find('github', 'gh-1')).toBeUndefined();
    expect(await store.find('github', 'gh-2')).toBeDefined();
  });
});

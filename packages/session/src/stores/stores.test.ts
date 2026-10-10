import { AesGcmEncrypter } from '@marmeon/encryption';
import { afterEach, describe, expect, it } from 'vitest';
import { EncryptedSessionCodec, plainSessionCodec, type SessionCodec } from '../codec.ts';
import type { SessionConfig } from '../config.ts';
import { Session } from '../session.ts';
import { createSessionId, SESSION_USER_KEY, sessionKey, type SessionPayload, type SessionStore, type SessionWrite } from '../store.ts';
import { UserSessions } from '../user-sessions.ts';
import { LIFETIME, storeKinds, storeUnderTest, type StoreUnderTest } from '../__fixtures__/stores.ts';

const config = { lifetime: LIFETIME / 60 } as SessionConfig;
const NEW = { expectedVersion: undefined, lifetimeSeconds: LIFETIME } satisfies SessionWrite;
const over = (version: number, lifetimeSeconds = LIFETIME): SessionWrite => ({ expectedVersion: version, lifetimeSeconds });

/** One request against `store`: start the session from `id`, run `use`, save. */
async function request(store: SessionStore, id: string | undefined, use: (session: Session) => void = () => {}, codec?: SessionCodec): Promise<Session> {
  const session = new Session(store, config, codec ?? plainSessionCodec);
  await session.start(id);
  use(session);
  await session.save();
  return session;
}

/** The payload stored for the session `id` — under its key, as JSON. */
async function payload(store: SessionStore, id: string): Promise<SessionPayload | undefined> {
  const stored = await store.read(sessionKey(id));
  return stored ? (JSON.parse(stored.data) as SessionPayload) : undefined;
}

/**
 * The store, with a sign-out landing at the worst moment of another request's `save()`: right after the store answered a
 * read of `key`, or right before a write of `key` — once, when armed. A read-then-write `save()` resurrects the session here; a
 * compare-and-set cannot.
 */
function signOutDuringSave(store: SessionStore, key: string, signOut: () => Promise<unknown>): SessionStore & { arm(): void } {
  let armed = false;
  const strike = async () => {
    if (!armed) return;
    armed = false;
    await signOut();
  };
  return {
    arm: () => void (armed = true),
    read: async (k) => {
      const data = await store.read(k);
      if (k === key) await strike();
      return data;
    },
    write: async (k, data, options) => {
      if (k === key && options.expectedVersion !== undefined) await strike();
      return store.write(k, data, options);
    },
    destroy: (k) => store.destroy(k),
    gc: (lifetime) => store.gc(lifetime),
  };
}

// ONE suite for every session store: memory, file, database on SQLite — and on Postgres (`pnpm test:pgsql`) and Redis
// (`pnpm test:redis`). Above all: a write compares the version in one atomic step and never brings back a session a
// sign-out destroyed; keys are the ids' hashes.
describe.each(storeKinds)('the %s session store', (kind) => {
  let current: StoreUnderTest | undefined;
  afterEach(async () => {
    await current?.close();
    current = undefined;
  });
  const open = async () => (current = await storeUnderTest(kind));
  /** Long enough for a session written with a lifetime of 1 s to expire — the database store's lifetime is its own. */
  const expiry = kind === 'sqlite' || kind === 'pgsql' ? (LIFETIME + 1) * 1000 : 1_100;
  const key = () => sessionKey(createSessionId());

  it('writes, reads, writes back over the version it read, and destroys sessions', async () => {
    const { store } = await open();
    const k = key();
    expect(await store.read(k)).toBeUndefined();
    expect(await store.write(k, '{"name":"Ada","cart":["book"]}', NEW)).toBe('written');
    expect(await store.read(k)).toEqual({ data: '{"name":"Ada","cart":["book"]}', version: 1 });
    expect(await store.write(k, '{"name":"Ada"}', over(1))).toBe('written');
    expect(await store.read(k)).toEqual({ data: '{"name":"Ada"}', version: 2 });
    // A longer record, then a shorter one: the file store overwrites in place.
    expect(await store.write(k, JSON.stringify({ note: 'x'.repeat(500) }), over(2))).toBe('written');
    expect(await store.write(k, '{"note":"y"}', over(3))).toBe('written');
    expect(await store.read(k)).toEqual({ data: '{"note":"y"}', version: 4 });
    await store.destroy(k);
    expect(await store.read(k)).toBeUndefined();
  });

  it("ends a user's sessions as a whole where it knows whose they are (database) — a deleted account's; others keep them", async () => {
    const { store } = await open();
    const ada = await request(store, undefined, (session) => session.put(SESSION_USER_KEY, 7));
    const adaPhone = await request(store, undefined, (session) => session.put(SESSION_USER_KEY, 7));
    const alan = await request(store, undefined, (session) => session.put(SESSION_USER_KEY, 8));
    const guest = await request(store, undefined, (session) => session.put('visits' as never, 1 as never));
    const sessions = new UserSessions(() => store);
    if (kind === 'sqlite' || kind === 'pgsql') {
      expect(await sessions.end(7)).toBe(2);
      expect(await payload(store, ada.id)).toBeUndefined();
      expect(await payload(store, adaPhone.id)).toBeUndefined();
    } else {
      expect(store.destroyUser).toBeUndefined();
      expect(await sessions.end(7)).toBe(0);
      expect(await payload(store, ada.id)).toBeDefined();
    }
    expect(await payload(store, alan.id)).toMatchObject({ [SESSION_USER_KEY]: 8 });
    expect(await payload(store, guest.id)).toBeDefined();
    expect(await new UserSessions(undefined).end(8)).toBe(0); // the cookie driver: nothing on the server
  });

  it('compares and sets: a write over an older version is a conflict and writes nothing — a new key never replaces a session', async () => {
    const { store } = await open();
    const k = key();
    await store.write(k, '{"v":1}', NEW);
    expect(await store.write(k, '{"v":2}', over(1))).toBe('written');
    expect(await store.write(k, '{"stale":true}', over(1))).toBe('conflict');
    expect(await store.write(k, '{"ahead":true}', over(7))).toBe('conflict');
    expect(await store.write(k, '{"new":true}', NEW)).toBe('conflict');
    expect(await store.read(k)).toEqual({ data: '{"v":2}', version: 2 });
  });

  it('writes back only what exists: an unknown or destroyed key is gone and stays absent', async () => {
    const { store, rows } = await open();
    const unknown = key();
    expect(await store.write(unknown, '{"user":1}', over(1))).toBe('gone');
    expect(await store.read(unknown)).toBeUndefined();
    const destroyed = key();
    await store.write(destroyed, '{"user":1}', NEW);
    await store.destroy(destroyed);
    expect(await store.write(destroyed, '{"user":1}', over(1))).toBe('gone');
    expect(await store.read(destroyed)).toBeUndefined();
    expect(await rows()).toBe(0);
  });

  it('expires sessions — and does not write an expired one back', async () => {
    const { store, pass } = await open();
    const k = key();
    await store.write(k, '{"user":1}', { expectedVersion: undefined, lifetimeSeconds: 1 });
    await pass(expiry);
    expect(await store.read(k)).toBeUndefined();
    expect(await store.write(k, '{"user":1}', over(1))).toBe('gone');
    expect(await store.read(k)).toBeUndefined();
  });

  it('collects expired sessions (gc) — Redis expires them itself', async () => {
    const { store, pass } = await open();
    const old = key();
    await store.write(old, '{"user":1}', { expectedVersion: undefined, lifetimeSeconds: 1 });
    await pass(expiry);
    const fresh = key();
    await store.write(fresh, '{"user":2}', NEW);
    expect(await store.gc(1)).toBe(kind === 'redis' ? 0 : 1);
    expect(await store.read(fresh)).toEqual({ data: '{"user":2}', version: 1 });
    expect(await store.gc(1)).toBe(0);
  });

  it('never leaves a session behind that a destroy raced — 50 write-backs and destroys at once', async () => {
    const { store } = await open();
    const keys = Array.from({ length: 50 }, key);
    for (const k of keys) await store.write(k, JSON.stringify({ user: 1, note: 'x'.repeat(200) }), NEW);
    // Each write-back may land before its destroy (then the destroy removes it) or after (then it is gone) — never between a
    // look and a write.
    await Promise.all(keys.flatMap((k) => [store.write(k, '{"user":1,"note":"y"}', over(1)), store.destroy(k)]));
    const left = (await Promise.all(keys.map((k) => store.read(k)))).filter((data) => data !== undefined);
    expect(left).toEqual([]);
  });

  it('lets exactly one of many writers over the same version through', async () => {
    const { store } = await open();
    const k = key();
    await store.write(k, '{}', NEW);
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => store.write(k, JSON.stringify({ writer: i }), over(1))));
    expect(results.filter((result) => result === 'written')).toHaveLength(1);
    expect(results.filter((result) => result === 'conflict')).toHaveLength(9);
    expect((await store.read(k))!.version).toBe(2);
  });

  it('keeps the session under the hash of its id — the id itself is in no key', async () => {
    const { store } = await open();
    const session = await request(store, undefined, (s) => s.put(SESSION_USER_KEY, '7'));
    expect(await payload(store, session.id)).toMatchObject({ [SESSION_USER_KEY]: '7' });
    if (kind !== 'file') expect(await store.read(session.id)).toBeUndefined(); // the file store refuses a non-key outright
    expect(sessionKey(session.id)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a key read from the store, sent as the cookie, is no session', async () => {
    const { store } = await open();
    const session = await request(store, undefined, (s) => s.put(SESSION_USER_KEY, '7'));
    const replay = await request(store, sessionKey(session.id));
    expect(replay.get(SESSION_USER_KEY)).toBeUndefined();
  });

  it('a sign-out landing inside another request’s save stays a sign-out — compare-and-set never revives it', async () => {
    const { store } = await open();
    const signedIn = await request(store, undefined, (session) => session.put(SESSION_USER_KEY, '7'));
    let signedOut: Session | undefined;
    const hooked = signOutDuringSave(store, sessionKey(signedIn.id), async () => {
      signedOut = await request(store, signedIn.id, (session) => session.invalidate());
    });
    // Request A (a page's deferred props) loads the signed-in session …
    const slow = new Session(hooked, config, plainSessionCodec);
    await slow.start(signedIn.id);
    slow.put('seen', true);
    // … and while it saves, the sign-out destroys it.
    hooked.arm();
    expect(await slow.save()).toBe(false);
    expect(signedOut).toBeDefined(); // the sign-out did land inside the save
    expect(await store.read(sessionKey(signedIn.id))).toBeUndefined();
    expect((await request(store, signedIn.id)).get(SESSION_USER_KEY)).toBeUndefined();
    expect(await payload(store, signedOut!.id)).toBeDefined();
  });

  it('a sign-in (a regenerated id) is written under its new key — and the old key is gone', async () => {
    const { store } = await open();
    const guest = await request(store, undefined, (session) => session.put('cart', ['book']));
    const signedIn = await request(store, guest.id, (session) => {
      session.regenerate();
      session.put(SESSION_USER_KEY, '7');
    });
    expect(signedIn.id).not.toBe(guest.id);
    expect(await store.read(sessionKey(guest.id))).toBeUndefined();
    expect(await payload(store, signedIn.id)).toMatchObject({ cart: ['book'], [SESSION_USER_KEY]: '7' } satisfies SessionPayload);
  });

  it('20 requests that flash at once: all 20 messages arrive', async () => {
    const { store } = await open();
    const { id } = await request(store, undefined, (session) => session.put(SESSION_USER_KEY, '7'));
    const sessions = await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        const session = new Session(store, config, plainSessionCodec);
        await session.start(id);
        session.queueFlash({ id: `m${i}`, key: 'toast', data: { i } });
        return session;
      }),
    );
    const saved = await Promise.all(sessions.map((session) => session.save()));
    // Every save landed (a conflict is merged, not lost) — or at worst gave up loudly (`abandoned`): never a silent loss.
    expect(sessions.filter((session) => session.abandoned)).toEqual([]);
    expect(saved.every(Boolean)).toBe(true);
    const messages = ((await payload(store, id))!._flash_messages as { id: string }[]).map((message) => message.id);
    expect(messages.toSorted()).toEqual(Array.from({ length: 20 }, (_, i) => `m${i}`).toSorted());
  });

  it('a message a faster request showed does not come back with a slower request’s copy', async () => {
    const { store } = await open();
    const { id } = await request(store, undefined, (session) => session.queueFlash({ id: 'saved', key: 'toast', data: 'Saved.' }));
    // B — a prefetch — loads the session while the message waits …
    const prefetch = new Session(store, config, plainSessionCodec);
    await prefetch.start(id);
    prefetch.put('seen', 1);
    // … A shows it (takes it) and saves first …
    await request(store, id, (session) => expect(session.takeFlash().map((message) => message.id)).toEqual(['saved']));
    // … B saves its copy afterwards: a conflict, merged — B's own change stays, the message stays shown.
    expect(await prefetch.save()).toBe(true);
    expect(await payload(store, id)).toMatchObject({ seen: 1 });
    expect((await payload(store, id))!._flash_messages).toBeUndefined();
  });

  it('a message the slower request showed stays shown when a faster one flashed another meanwhile', async () => {
    const { store } = await open();
    const { id } = await request(store, undefined, (session) => session.queueFlash({ id: 'm1', key: 'toast', data: 'One' }));
    const page = new Session(store, config, plainSessionCodec);
    await page.start(id);
    await request(store, id, (session) => session.queueFlash({ id: 'm2', key: 'toast', data: 'Two' }));
    expect(page.takeFlash().map((message) => message.id)).toEqual(['m1']);
    expect(await page.save()).toBe(true);
    expect(((await payload(store, id))!._flash_messages as { id: string }[]).map((message) => message.id)).toEqual(['m2']);
  });

  it('a conflict whose second read finds the session signed out stays signed out', async () => {
    const { store } = await open();
    const signedIn = await request(store, undefined, (session) => session.put(SESSION_USER_KEY, '7'));
    const key = sessionKey(signedIn.id);
    let armed = false;
    const hooked: SessionStore = {
      read: async (k) => {
        if (armed && k === key) {
          armed = false;
          await request(store, signedIn.id, (session) => session.invalidate());
        }
        return store.read(k);
      },
      write: (k, data, options) => store.write(k, data, options),
      destroy: (k) => store.destroy(k),
      gc: (lifetime) => store.gc(lifetime),
    };
    const slow = new Session(hooked, config, plainSessionCodec);
    await slow.start(signedIn.id);
    slow.put('seen', true);
    await request(store, signedIn.id, (session) => session.put('elsewhere', 1)); // the slow one's write is now a conflict …
    armed = true; // … and the sign-out lands before it reads the session again
    expect(await slow.save()).toBe(false);
    expect(await store.read(key)).toBeUndefined();
  });

  it('a conflict without flash: last write wins key by key — and both requests’ own keys stay', async () => {
    const { store } = await open();
    const { id } = await request(store, undefined, (session) => session.put('theme', 'light'));
    const a = new Session(store, config, plainSessionCodec);
    const b = new Session(store, config, plainSessionCodec);
    await a.start(id);
    await b.start(id);
    a.put('theme', 'dark');
    a.put('cart', ['book']);
    b.put('theme', 'blue');
    b.put('locale', 'de');
    expect(await a.save()).toBe(true);
    expect(await b.save()).toBe(true); // a conflict: read again, merged, written — once
    expect(await payload(store, id)).toMatchObject({ theme: 'blue', cart: ['book'], locale: 'de' });
  });

  it('with SESSION_ENCRYPT the store holds no plaintext — and a payload moved to another session does not open there', async () => {
    const { store } = await open();
    const codec = new EncryptedSessionCodec(new AesGcmEncrypter(new Uint8Array(32).fill(7)));
    const ada = await request(store, undefined, (s) => (s.put(SESSION_USER_KEY, 'user-ada-17'), s.queueFlash({ id: 'x', key: 'toast', data: 'Welcome back, Ada' })), codec);
    const stored = (await store.read(sessionKey(ada.id)))!;
    // What the plaintext would hold, in forms a ciphertext cannot (base64url has no quote, space or comma): a short word alone
    // can turn up in random ciphertext.
    expect(stored.data).not.toMatch(/Welcome back, Ada|user-ada-17|"_token"|"toast"/);
    expect((await request(store, ada.id, () => {}, codec)).get(SESSION_USER_KEY)).toBe('user-ada-17');
    // Mallory's own session, Ada's ciphertext copied into its place: bound to Ada's key, it does not decrypt as Mallory's.
    const mallory = await request(store, undefined, (s) => s.put('name', 'Mallory'), codec);
    await store.destroy(sessionKey(mallory.id));
    await store.write(sessionKey(mallory.id), stored.data, NEW);
    expect((await request(store, mallory.id, () => {}, codec)).get(SESSION_USER_KEY)).toBeUndefined();
  });
});

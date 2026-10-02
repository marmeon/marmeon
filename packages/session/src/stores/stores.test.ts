import { afterEach, describe, expect, it } from 'vitest';
import type { SessionConfig } from '../config.ts';
import { Session } from '../session.ts';
import { createSessionId, SESSION_USER_KEY, type SessionPayload, type SessionStore } from '../store.ts';
import { LIFETIME, storeKinds, storeUnderTest, type StoreUnderTest } from '../__fixtures__/stores.ts';

const config = { lifetime: LIFETIME / 60 } as SessionConfig;

/** One request against `store`: start the session from `id`, run `use`, save. */
async function request(store: SessionStore, id: string | undefined, use: (session: Session) => void = () => {}): Promise<Session> {
  const session = new Session(store, config);
  await session.start(id);
  use(session);
  await session.save();
  return session;
}

/**
 * The store, with a sign-out landing at the worst moment of another request's `save()` (E45): right after the store
 * answered a read of `id` (between a read and the write that follows it), or right before a write-back of `id` — once,
 * when armed. A read-then-write `save()` resurrects the session here; an atomic `writeIfExists` cannot.
 */
function signOutDuringSave(store: SessionStore, id: string, signOut: () => Promise<unknown>): SessionStore & { arm(): void } {
  let armed = false;
  const strike = async () => {
    if (!armed) return;
    armed = false;
    await signOut();
  };
  return {
    arm: () => void (armed = true),
    read: async (key) => {
      const data = await store.read(key);
      if (key === id) await strike();
      return data;
    },
    write: (key, data, lifetime) => store.write(key, data, lifetime),
    writeIfExists: async (key, data, lifetime) => {
      if (key === id) await strike();
      return store.writeIfExists(key, data, lifetime);
    },
    destroy: (key) => store.destroy(key),
    gc: (lifetime) => store.gc(lifetime),
  };
}

// ONE suite for every session store: memory, file, database on SQLite — and on Postgres (`pnpm test:pgsql`) and Redis
// (`pnpm test:redis`). Above all: writing a session back never brings back one a sign-out destroyed (E45).
describe.each(storeKinds)('the %s session store', (kind) => {
  let current: StoreUnderTest | undefined;
  afterEach(async () => {
    await current?.close();
    current = undefined;
  });
  const open = async () => (current = await storeUnderTest(kind));
  /** Long enough for a session written with a lifetime of 1 s to expire — the database store's lifetime is its own. */
  const expiry = kind === 'sqlite' || kind === 'pgsql' ? (LIFETIME + 1) * 1000 : 1_100;

  it('writes, reads, writes back and destroys sessions', async () => {
    const { store } = await open();
    const id = createSessionId();
    expect(await store.read(id)).toBeUndefined();
    await store.write(id, { name: 'Ada', cart: ['book'] }, LIFETIME);
    expect(await store.read(id)).toEqual({ name: 'Ada', cart: ['book'] });
    expect(await store.writeIfExists(id, { name: 'Ada' }, LIFETIME)).toBe(true);
    expect(await store.read(id)).toEqual({ name: 'Ada' });
    // A longer record, then a shorter one: the file store overwrites in place.
    expect(await store.writeIfExists(id, { note: 'x'.repeat(500) }, LIFETIME)).toBe(true);
    expect(await store.writeIfExists(id, { note: 'y' }, LIFETIME)).toBe(true);
    expect(await store.read(id)).toEqual({ note: 'y' });
    await store.destroy(id);
    expect(await store.read(id)).toBeUndefined();
  });

  it('writes back only what exists: an unknown or destroyed id stays absent (a regenerated id goes through write)', async () => {
    const { store, rows } = await open();
    const unknown = createSessionId();
    expect(await store.writeIfExists(unknown, { user: 1 }, LIFETIME)).toBe(false);
    expect(await store.read(unknown)).toBeUndefined();
    const destroyed = createSessionId();
    await store.write(destroyed, { user: 1 }, LIFETIME);
    await store.destroy(destroyed);
    expect(await store.writeIfExists(destroyed, { user: 1 }, LIFETIME)).toBe(false);
    expect(await store.read(destroyed)).toBeUndefined();
    expect(await rows()).toBe(0);
  });

  it('expires sessions — and does not write an expired one back', async () => {
    const { store, pass } = await open();
    const id = createSessionId();
    await store.write(id, { user: 1 }, 1);
    await pass(expiry);
    expect(await store.read(id)).toBeUndefined();
    expect(await store.writeIfExists(id, { user: 1 }, LIFETIME)).toBe(false);
    expect(await store.read(id)).toBeUndefined();
  });

  it('collects expired sessions (gc) — Redis expires them itself', async () => {
    const { store, pass } = await open();
    const old = createSessionId();
    await store.write(old, { user: 1 }, 1);
    await pass(expiry);
    const fresh = createSessionId();
    await store.write(fresh, { user: 2 }, LIFETIME);
    expect(await store.gc(1)).toBe(kind === 'redis' ? 0 : 1);
    expect(await store.read(fresh)).toEqual({ user: 2 });
    expect(await store.gc(1)).toBe(0);
  });

  it('never leaves a session behind that a destroy raced — 50 write-backs and destroys at once', async () => {
    const { store } = await open();
    const ids = Array.from({ length: 50 }, () => createSessionId());
    for (const id of ids) await store.write(id, { user: 1, note: 'x'.repeat(200) }, LIFETIME);
    // Each write-back may land before its destroy (then the destroy removes it) or after (then it finds nothing) — never
    // between a look and a write.
    await Promise.all(ids.flatMap((id) => [store.writeIfExists(id, { user: 1, note: 'y' }, LIFETIME), store.destroy(id)]));
    const left = (await Promise.all(ids.map((id) => store.read(id)))).filter((data) => data !== undefined);
    expect(left).toEqual([]);
  });

  it('a sign-out landing inside another request’s save stays a sign-out (E45)', async () => {
    const { store } = await open();
    const signedIn = await request(store, undefined, (session) => session.put(SESSION_USER_KEY, '7'));
    let signedOut: Session | undefined;
    const hooked = signOutDuringSave(store, signedIn.id, async () => {
      signedOut = await request(store, signedIn.id, (session) => session.invalidate());
    });

    // Request A (a page's deferred props) loads the signed-in session …
    const slow = new Session(hooked, config);
    await slow.start(signedIn.id);
    slow.put('seen', true);
    // … and while it saves, the sign-out destroys it.
    hooked.arm();
    expect(await slow.save()).toBe(false);
    expect(signedOut).toBeDefined(); // the sign-out did land inside the save
    expect(await store.read(signedIn.id)).toBeUndefined();
    expect((await request(store, signedIn.id)).get(SESSION_USER_KEY)).toBeUndefined();
    expect(await store.read(signedOut!.id)).toBeDefined();
  });

  it('a sign-in (a regenerated id) is written under its new id — and the old id is gone', async () => {
    const { store } = await open();
    const guest = await request(store, undefined, (session) => session.put('cart', ['book']));
    const signedIn = await request(store, guest.id, (session) => {
      session.regenerate();
      session.put(SESSION_USER_KEY, '7');
    });
    expect(signedIn.id).not.toBe(guest.id);
    expect(await store.read(guest.id)).toBeUndefined();
    expect(await store.read(signedIn.id)).toMatchObject({ cart: ['book'], [SESSION_USER_KEY]: '7' } satisfies SessionPayload);
  });
});

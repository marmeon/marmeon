import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CookieJar } from '@bespokecore/router';
import { afterAll, describe, expect, expectTypeOf, it } from 'vitest';
import { plainSessionCodec } from './codec.ts';
import type { SessionConfig } from './config.ts';
import { Session } from './session.ts';
import { sessionKey, type SessionPayload, type SessionStore } from './store.ts';
import { CookieSessionStore } from './stores/cookie.ts';
import { FileSessionStore } from './stores/file.ts';
import { MemorySessionStore } from './stores/memory.ts';

declare module './session.ts' {
  interface SessionData {
    user_id: string;
    visits: number;
  }
}

const config = { lifetime: 120 } as SessionConfig;

/** One request: start the session from `id`, run `use`, save. Returns the id for the next request. */
async function request(store: SessionStore, id: string | undefined, use: (session: Session) => void = () => {}): Promise<Session> {
  const session = new Session(store, config, plainSessionCodec);
  await session.start(id);
  use(session);
  await session.save();
  return session;
}

/** The payload stored for the session `id` (under its key, E144), as JSON. */
async function stored(store: SessionStore, id: string): Promise<SessionPayload | undefined> {
  const record = await store.read(sessionKey(id));
  return record ? (JSON.parse(record.data) as SessionPayload) : undefined;
}

describe('Session', () => {
  it('starts a new session for unknown, invalid or missing ids — never trusting the client', async () => {
    const store = new MemorySessionStore();
    const fresh = await request(store, undefined);
    expect(fresh.id).toMatch(/^[A-Za-z0-9_-]{40}$/);
    expect((await request(store, 'x'.repeat(40))).id).not.toBe('x'.repeat(40));
    expect((await request(store, '../../etc/passwd')).id).toMatch(/^[A-Za-z0-9_-]{40}$/);
  });

  it('keeps data across requests', async () => {
    const store = new MemorySessionStore();
    const first = await request(store, undefined, (session) => {
      session.put('user_id', '1');
      session.put('visits', 1);
      session.put('cart', ['book']);
    });
    const second = await request(store, first.id, (session) => {
      expect(session.id).toBe(first.id);
      expect(session.get('user_id')).toBe('1');
      expect(session.pull('cart')).toEqual(['book']);
      session.forget('visits');
    });
    await request(store, second.id, (session) => {
      expect(session.all()).toEqual({ user_id: '1' }); // no _token / _flash bookkeeping
      expect(session.has('cart')).toBe(false);
    });
  });

  it('keeps flash data for exactly one following request', async () => {
    const store = new MemorySessionStore();
    const { id } = await request(store, undefined, (session) => session.flash('status', 'Saved.'));
    await request(store, id, (session) => expect(session.get('status')).toBe('Saved.'));
    await request(store, id, (session) => expect(session.get('status')).toBeUndefined());
  });

  it('keeps flash messages (E60) until a response takes them — not aged by the requests in between; a 409 puts them back', async () => {
    const store = new MemorySessionStore();
    const message = (id: string) => ({ id, key: 'toast', data: { message: 'Saved.' } });
    const { id } = await request(store, undefined, (session) => session.queueFlash(message('1')));
    // A prefetch, an island, an API call: none takes them — they wait, however many there are.
    for (let other = 0; other < 3; other++) await request(store, id, (session) => expect(session.hasFlash()).toBe(true));
    await request(store, id, (session) => {
      expect(session.takeFlash()).toEqual([message('1')]);
      // The answer became a 409 (signed in or out, a new build): not shown — back for the page that loads instead.
      session.reflash();
    });
    await request(store, id, (session) => {
      expect(session.takeFlash().map((taken) => taken.id)).toEqual(['1']);
      expect(session.takeFlash()).toEqual([]);
    });
    await request(store, id, (session) => expect(session.hasFlash()).toBe(false));
    // A read-only request (an island) takes none.
    const { id: second } = await request(store, undefined, (session) => session.queueFlash(message('2')));
    const island = new Session(store, config, plainSessionCodec);
    await island.start(second);
    island.lock(() => false);
    expect(island.takeFlash()).toEqual([]);
    expect(island.all()).toEqual({});
  });

  it('binds a flash message to the document whose request flashed it (E165): another document leaves it, a full load takes it', async () => {
    const store = new MemorySessionStore();
    const message = (id: string, document?: string) => ({ id, key: 'toast', data: { message: 'Saved.' }, ...(document ? { document } : {}) });
    const { id } = await request(store, undefined, (session) => {
      session.queueFlash(message('a', 'tab-a'));
      session.queueFlash(message('free'));
    });
    // Tab B's request: only the message bound to no document; tab A's stays — and waits for A.
    await request(store, id, (session) => {
      expect(session.hasFlash('tab-b')).toBe(true);
      expect(session.takeFlash('tab-b').map((taken) => taken.id)).toEqual(['free']);
      expect(session.hasFlash('tab-b')).toBe(false);
      expect(session.hasFlash('tab-a')).toBe(true);
    });
    await request(store, id, (session) => expect(session.takeFlash('tab-a').map((taken) => taken.id)).toEqual(['a']));
    // A request naming no document (a full page load) takes every message.
    await request(store, id, (session) => session.queueFlash(message('b', 'tab-b')));
    await request(store, id, (session) => expect(session.takeFlash().map((taken) => taken.id)).toEqual(['b']));
  });

  it('can keep flash data longer (reflash, keep) and flash input for old()', async () => {
    const store = new MemorySessionStore();
    const { id } = await request(store, undefined, (session) => {
      session.flash('a', 1);
      session.flash('b', 2);
      session.flashInput({ name: 'Ada', email: 'x' });
    });
    await request(store, id, (session) => {
      expect(session.old('name')).toBe('Ada');
      expect(session.old()).toEqual({ name: 'Ada', email: 'x' });
      session.keep('a');
    });
    await request(store, id, (session) => {
      expect([session.get('a'), session.get('b')]).toEqual([1, undefined]);
      session.reflash();
    });
    await request(store, id, (session) => expect(session.get('a')).toBe(1));
  });

  it('regenerates the id and token but keeps the data — and destroys the old id (session fixation)', async () => {
    const store = new MemorySessionStore();
    const planted = await request(store, undefined, (session) => session.put('visits', 3));
    const token = planted.token();
    const login = await request(store, planted.id, (session) => {
      session.regenerate();
      session.put('user_id', '1');
    });

    expect(login.id).not.toBe(planted.id);
    expect(login.token()).not.toBe(token);
    expect(await stored(store, planted.id)).toBeUndefined();
    await request(store, login.id, (session) => expect(session.all()).toEqual({ visits: 3, user_id: '1' }));
  });

  it('invalidates everything on logout', async () => {
    const store = new MemorySessionStore();
    const before = await request(store, undefined, (session) => session.put('user_id', '1'));
    const after = await request(store, before.id, (session) => session.invalidate());
    expect(after.id).not.toBe(before.id);
    await request(store, after.id, (session) => expect(session.get('user_id')).toBeUndefined());
  });

  it('never writes back a session another request destroyed meanwhile — a sign-out stays a sign-out', async () => {
    const store = new MemorySessionStore();
    const signedIn = await request(store, undefined, (session) => session.put('user_id', '1'));

    // A slow request (a page's deferred props) starts with the signed-in session …
    const slow = new Session(store, config, plainSessionCodec);
    await slow.start(signedIn.id);
    // … the sign-out overtakes it …
    const signedOut = await request(store, signedIn.id, (session) => session.invalidate());
    // … and then the slow one finishes: nothing written, the old id stays gone.
    expect(await slow.save()).toBe(false);
    expect(await stored(store, signedIn.id)).toBeUndefined();
    expect((await request(store, signedIn.id)).get('user_id')).toBeUndefined();
    expect(await stored(store, signedOut.id)).toBeDefined();
  });

  it('keeps the CSRF token stable across requests', async () => {
    const store = new MemorySessionStore();
    let token = '';
    const first = await request(store, undefined, (session) => (token = session.token())); // handed out, like a page does
    expect(token).toMatch(/^[A-Za-z0-9_-]{40}$/);
    expect((await request(store, first.id)).token()).toBe(token);
  });

  it('does not write a new session that holds nothing — data, flash or a handed-out token keep it', async () => {
    const store = new MemorySessionStore();
    const writes: string[] = [];
    const counting: SessionStore = {
      read: (key) => store.read(key),
      write: async (key, data, options) => (writes.push(key), store.write(key, data, options)),
      destroy: (key) => store.destroy(key),
      gc: () => store.gc(),
    };
    const save = async (use: (session: Session) => void = () => {}) => {
      const session = new Session(counting, config, plainSessionCodec);
      await session.start(undefined);
      use(session);
      return { saved: await session.save(), persists: session.persists };
    };
    // A health check, a bot, an API call: nothing used — nothing written (and StartSession sends no cookie).
    expect(await save()).toEqual({ saved: false, persists: false });
    expect(await save((session) => (session.get('user_id'), session.id, session.regenerateToken()))).toEqual({ saved: false, persists: false });
    // A sign-out without a session: a new id, still nothing in it.
    expect(await save((session) => session.invalidate())).toEqual({ saved: false, persists: false });
    expect(writes).toEqual([]);
    // Worth keeping: data, flash data, a flash message, a token in the response (every page, a form).
    expect(await save((session) => session.put('visits', 1))).toEqual({ saved: true, persists: true });
    expect(await save((session) => session.flash('status', 'Saved.'))).toEqual({ saved: true, persists: true });
    expect(await save((session) => session.queueFlash({ id: '1', key: 'toast', data: {} }))).toEqual({ saved: true, persists: true });
    expect(await save((session) => session.token())).toEqual({ saved: true, persists: true });
    expect(writes).toHaveLength(4);
  });

  it('writes a loaded session back in one atomic step (compare-and-set on its version) — no read before it', async () => {
    const store = new MemorySessionStore();
    const { id } = await request(store, undefined, (session) => session.put('visits', 1));
    const calls: string[] = [];
    const watched: SessionStore = {
      read: (key) => (calls.push('read'), store.read(key)),
      write: (key, data, options) => (calls.push(`write@${options.expectedVersion}`), store.write(key, data, options)),
      destroy: (key) => (calls.push('destroy'), store.destroy(key)),
      gc: () => store.gc(),
    };
    await request(watched, id, (session) => session.put('visits', 2));
    expect(calls).toEqual(['read', 'write@1']); // the load, then the write-back over the version it loaded
    calls.length = 0;
    // A sign-in: the old id goes, the NEW id is written as a new key (no version) — a write back would find nothing under it.
    const signedIn = await request(watched, id, (session) => {
      session.regenerate();
      session.put('user_id', '1');
    });
    expect(calls).toEqual(['read', 'destroy', 'write@undefined']);
    expect(await stored(store, signedIn.id)).toMatchObject({ visits: 2, user_id: '1' });
    expect(await store.read(sessionKey(id))).toBeUndefined();
  });

  it('a session other requests write without pause: save() gives up after a while — no endless retry, nothing written, said (E145)', async () => {
    const store = new MemorySessionStore();
    const { id } = await request(store, undefined, (session) => session.put('visits', 1));
    let writes = 0;
    // Every write meets a newer version: another request always got there first.
    const busy: SessionStore = {
      read: async (key) => {
        const current = await store.read(key);
        return current && { data: JSON.stringify({ ...JSON.parse(current.data), elsewhere: writes }), version: current.version + writes };
      },
      write: async () => (writes++, 'conflict'),
      destroy: (key) => store.destroy(key),
      gc: () => store.gc(),
    };
    const session = new Session(busy, config, plainSessionCodec);
    await session.start(id);
    session.put('visits', 2);
    const started = performance.now();
    expect(await session.save()).toBe(false);
    expect(session.abandoned).toBe(true);
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(writes).toBeGreaterThan(3);
    expect(JSON.parse((await store.read(sessionKey(id)))!.data)).toMatchObject({ visits: 1 });
  });

  it('stores a session under the SHA-256 of its id — never the id (E144)', async () => {
    const store = new MemorySessionStore();
    const keys: string[] = [];
    const watched: SessionStore = { read: (key) => store.read(key), write: (key, data, options) => (keys.push(key), store.write(key, data, options)), destroy: (key) => store.destroy(key), gc: () => store.gc() };
    const { id } = await request(watched, undefined, (session) => session.put('visits', 1));
    expect(keys).toEqual([sessionKey(id)]);
    expect(sessionKey(id)).toMatch(/^[0-9a-f]{64}$/);
    expect(await store.read(id)).toBeUndefined();
    // The key as a cookie value is no session: a store's keys sign nobody in.
    const replayed = await request(store, sessionKey(id));
    expect(replayed.id).not.toBe(sessionKey(id));
    expect(replayed.get('visits')).toBeUndefined();
  });

  it('explains a missing StartSession', () => {
    expect(() => new Session(new MemorySessionStore(), config, plainSessionCodec).get('user_id')).toThrow('add the StartSession middleware');
  });

  it('types declared keys and leaves the rest unknown', async () => {
    const session = await request(new MemorySessionStore(), undefined);
    expectTypeOf(session.get('user_id')).toEqualTypeOf<string | undefined>();
    expectTypeOf(session.get('anything')).toEqualTypeOf<unknown>();
    // @ts-expect-error -- user_id is declared as a string
    session.put('user_id', 1);
    session.put('anything', { free: 'form' });
  });
});

describe('session stores', () => {
  const directories: string[] = [];
  const tempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'bespoke-sessions-'));
    directories.push(dir);
    return dir;
  };
  afterAll(() => {
    for (const dir of directories) rmSync(dir, { recursive: true, force: true });
  });

  it('file: survives a restart (a new store instance), writes atomically, private files', async () => {
    const dir = tempDir();
    const { id } = await request(new FileSessionStore(dir), undefined, (session) => session.put('user_id', '7'));

    const restarted = new FileSessionStore(join(dir)); // like a new process
    await request(restarted, id, (session) => expect(session.get('user_id')).toBe('7'));
    expect(readdirSync(dir)).toEqual([sessionKey(id)]); // named by the key, no temporary files or guards left
    expect(statSync(join(dir, sessionKey(id))).mode & 0o777).toBe(0o600);
  });

  it('file: expires by lifetime and garbage-collects old files', async () => {
    const dir = tempDir();
    const store = new FileSessionStore(dir);
    await store.write('a'.repeat(64), '{"x":1}', { expectedVersion: undefined, lifetimeSeconds: -1 });
    expect(await store.read('a'.repeat(64))).toBeUndefined();

    await store.write('b'.repeat(64), '{"x":1}', { expectedVersion: undefined, lifetimeSeconds: 60 });
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(join(dir, 'b'.repeat(64)), past, past);
    expect(await store.gc(60)).toBe(1); // by modification time, like Laravel's file handler
    expect(existsSync(join(dir, 'a'.repeat(64)))).toBe(true); // expired by its data, collected once it is old
    expect(existsSync(join(dir, 'b'.repeat(64)))).toBe(false);
  });

  it('file: writes back in place without ever losing the session — racing writes and reads of long and short records', async () => {
    const store = new FileSessionStore(tempDir());
    const key = 'd'.repeat(64);
    await store.write(key, '', { expectedVersion: undefined, lifetimeSeconds: 60 });
    const records = Array.from({ length: 60 }, (_, i) => JSON.stringify({ round: i, note: (i % 2 === 0 ? 'long ' : 's').repeat(i % 2 === 0 ? 100_000 : 1) }));
    // Each writer writes over the version it read, again until it lands: in place, under the guard.
    const writeUntilWritten = async (data: string) => {
      for (;;) {
        const current = await store.read(key);
        if ((await store.write(key, data, { expectedVersion: current!.version, lifetimeSeconds: 60 })) === 'written') return true;
      }
    };
    const [written, read] = await Promise.all([Promise.all(records.map(writeUntilWritten)), Promise.all(records.map(() => store.read(key)))]);
    expect(written.every(Boolean)).toBe(true);
    // A reader that meets a write in progress reads again; whatever order the writes landed in, one whole record is left.
    expect(read.filter((data) => data === undefined)).toEqual([]);
    const last = await store.read(key);
    expect(records).toContain(last!.data);
    expect(last!.version).toBe(61);
  });

  it('file: refuses keys that are not session keys (SHA-256 hex) — a raw session id included', async () => {
    await expect(new FileSessionStore(tempDir()).destroy('../escape')).rejects.toThrow('Invalid session key');
    await expect(new FileSessionStore(tempDir()).read('A'.repeat(40))).rejects.toThrow('Invalid session key');
  });

  it('memory: expires by lifetime', async () => {
    const store = new MemorySessionStore();
    await store.write('c'.repeat(64), '{}', { expectedVersion: undefined, lifetimeSeconds: -1 });
    expect(await store.read('c'.repeat(64))).toBeUndefined();
    expect(await store.gc()).toBe(1);
  });

  it('cookie: keeps the data in a cookie next to the id — and refuses oversized sessions', async () => {
    const jar = new CookieJar(null);
    const store = new CookieSessionStore(jar, 'app_session');
    await store.write('ignored', '{"user_id":"1"}', { expectedVersion: undefined, lifetimeSeconds: 60 });
    const [cookie] = await jar.queued();
    expect(cookie).toMatch(/^app_session_data=.*Max-Age=60/);

    const next = new CookieSessionStore(new CookieJar(cookie!.split(';')[0]!), 'app_session');
    expect(await next.read()).toEqual({ data: '{"user_id":"1"}', version: 0 });
    await expect(store.write('x', JSON.stringify({ big: 'x'.repeat(3000) }), { expectedVersion: 0, lifetimeSeconds: 60 })).rejects.toThrow('too large for the cookie driver');
    // It cannot know what another request destroyed or wrote (E46): a write back always writes.
    expect(await new CookieSessionStore(new CookieJar(null), 'app_session').write('gone', '{}', { expectedVersion: 7, lifetimeSeconds: 60 })).toBe('written');
  });
});

describe('Session — read-only (an island, E52)', () => {
  it('asks before every write: a lenient lock drops it (production), the session is never saved', async () => {
    const store = new MemorySessionStore();
    const id = (await request(store, undefined, (session) => session.flash('visits', 1))).id;
    const asked: string[] = [];
    const session = new Session(store, config, plainSessionCodec);
    await session.start(id);
    session.lock((what) => (asked.push(what), false));
    expect(session.readOnly).toBe(true);
    session.put('visits', 2);
    session.flash('user_id', 'x');
    session.forget('visits');
    session.forget('nothing-there'); // changes nothing — not even asked
    session.regenerate();
    expect(session.id).toBe(id);
    expect(session.get('visits')).toBe(1);
    expect(asked).toEqual(["session.put('visits')", "session.flash('user_id')", "session.forget('visits')", 'session.regenerate()']);
    expect(await session.save()).toBe(false);
    // The flash data is still there for the page it was meant for — not aged by the island's request.
    let seen: unknown;
    await request(store, id, (page) => (seen = page.get('visits')));
    expect(seen).toBe(1);
  });

  it('a strict lock (development) throws where the write is made', async () => {
    const session = new Session(new MemorySessionStore(), config, plainSessionCodec);
    await session.start(undefined);
    session.lock((what) => {
      throw new Error(`no: ${what}`);
    });
    expect(() => session.put('visits', 1)).toThrow("no: session.put('visits')");
  });
});

// Type guarantees (never called — checked by the build): a store says what its compare-and-set did (E145).
function storeContract() {
  // @ts-expect-error -- the store contract before W8 (writeIfExists, payload objects) is not a SessionStore any more
  const legacy: SessionStore = { read: async () => undefined, write: async () => {}, writeIfExists: async () => true, destroy: async () => {}, gc: async () => 0 };
  const store: SessionStore = new MemorySessionStore();
  // @ts-expect-error -- a payload is text (JSON, or encrypted) — the store never sees an object
  void store.write('k', { user: 1 }, { expectedVersion: 1, lifetimeSeconds: 60 });
  // @ts-expect-error -- a write says what it did: written, conflict or gone — not a boolean
  const written: Promise<boolean> = store.write('k', '{}', { expectedVersion: 1, lifetimeSeconds: 60 });
  // @ts-expect-error -- the expected version is required: undefined for a new key, said out loud
  void store.write('k', '{}', { lifetimeSeconds: 60 });
  return [legacy, written];
}
void storeContract;

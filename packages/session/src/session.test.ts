import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CookieJar } from '@bespokecore/router';
import { afterAll, describe, expect, expectTypeOf, it } from 'vitest';
import type { SessionConfig } from './config.ts';
import { Session } from './session.ts';
import { CookieSessionStore, FileSessionStore, MemorySessionStore, type SessionStore } from './store.ts';

declare module './session.ts' {
  interface SessionData {
    user_id: string;
    visits: number;
  }
}

const config = { lifetime: 120 } as SessionConfig;

/** One request: start the session from `id`, run `use`, save. Returns the id for the next request. */
async function request(store: SessionStore, id: string | undefined, use: (session: Session) => void = () => {}): Promise<Session> {
  const session = new Session(store, config);
  await session.start(id);
  use(session);
  await session.save();
  return session;
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
    expect(await store.read(planted.id)).toBeUndefined();
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
    const slow = new Session(store, config);
    await slow.start(signedIn.id);
    // … the sign-out overtakes it …
    const signedOut = await request(store, signedIn.id, (session) => session.invalidate());
    // … and then the slow one finishes: nothing written, the old id stays gone.
    expect(await slow.save()).toBe(false);
    expect(await store.read(signedIn.id)).toBeUndefined();
    expect((await request(store, signedIn.id)).get('user_id')).toBeUndefined();
    expect(await store.read(signedOut.id)).toBeDefined();
  });

  it('keeps the CSRF token stable across requests', async () => {
    const store = new MemorySessionStore();
    const first = await request(store, undefined);
    expect(first.token()).toMatch(/^[A-Za-z0-9_-]{40}$/);
    expect((await request(store, first.id)).token()).toBe(first.token());
  });

  it('explains a missing StartSession', () => {
    expect(() => new Session(new MemorySessionStore(), config).get('user_id')).toThrow('add the StartSession middleware');
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
    expect(readdirSync(dir)).toEqual([id]); // no temporary files left
    expect(statSync(join(dir, id)).mode & 0o777).toBe(0o600);
  });

  it('file: expires by lifetime and garbage-collects old files', async () => {
    const dir = tempDir();
    const store = new FileSessionStore(dir);
    await store.write('a'.repeat(40), { x: 1 }, -1);
    expect(await store.read('a'.repeat(40))).toBeUndefined();

    await store.write('b'.repeat(40), { x: 1 }, 60);
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(join(dir, 'b'.repeat(40)), past, past);
    expect(await store.gc(60)).toBe(1); // by modification time, like Laravel's file handler
    expect(existsSync(join(dir, 'a'.repeat(40)))).toBe(true); // expired by its data, collected once it is old
    expect(existsSync(join(dir, 'b'.repeat(40)))).toBe(false);
  });

  it('file: refuses ids that are not session ids', async () => {
    await expect(new FileSessionStore(tempDir()).destroy('../escape')).rejects.toThrow('Invalid session id');
  });

  it('memory: expires by lifetime', async () => {
    const store = new MemorySessionStore();
    await store.write('c'.repeat(40), { x: 1 }, -1);
    expect(await store.read('c'.repeat(40))).toBeUndefined();
    expect(await store.gc()).toBe(1);
  });

  it('cookie: keeps the data in a cookie next to the id — and refuses oversized sessions', async () => {
    const jar = new CookieJar(null);
    const store = new CookieSessionStore(jar, 'app_session');
    await store.write('ignored', { user_id: '1' }, 60);
    const [cookie] = await jar.queued();
    expect(cookie).toMatch(/^app_session_data=.*Max-Age=60/);

    const next = new CookieSessionStore(new CookieJar(cookie!.split(';')[0]!), 'app_session');
    expect(await next.read()).toEqual({ user_id: '1' });
    await expect(store.write('x', { big: 'x'.repeat(3000) }, 60)).rejects.toThrow('too large for the cookie driver');
  });
});

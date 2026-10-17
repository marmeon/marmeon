import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { plainSessionCodec } from './codec.ts';
import type { SessionConfig } from './config.ts';
import { openPayload, SESSION_READERS } from './format.ts';
import { Session } from './session.ts';
import { createSessionId, sessionKey, type SessionStore } from './store.ts';
import { MemorySessionStore } from './stores/memory.ts';

const config = { lifetime: 120 } as SessionConfig;
const NEW = { expectedVersion: undefined, lifetimeSeconds: 600 };
const FIXTURES = new URL('./__fixtures__/formats/session-payload/', import.meta.url);

/** Keeps `payload` as `json` under a new id — a session as some process left it. */
async function seed(store: SessionStore, json: string): Promise<{ id: string; key: string }> {
  const id = createSessionId();
  const key = sessionKey(id);
  expect(await store.write(key, json, NEW)).toBe('written');
  return { id, key };
}

async function load(store: SessionStore, id: string | undefined): Promise<Session> {
  const session = new Session(store, config, plainSessionCodec);
  await session.start(id);
  return session;
}

afterEach(() => {
  SESSION_READERS.delete(2);
});

describe('the session payload format', () => {
  const fixtures = readdirSync(FIXTURES).filter((file) => file.endsWith('.json'));

  it('has a fixture for every supported version', () => {
    expect(fixtures).toContain('v1.json');
  });

  it.each(fixtures)('reads the fixture %s — without its mark in the data — and writes it back marked', async (file) => {
    const text = readFileSync(new URL(file, FIXTURES), 'utf8');
    const expected = JSON.parse(text) as Record<string, unknown>;
    const store = new MemorySessionStore();
    const { id, key } = await seed(store, text);
    const session = await load(store, id);
    expect(session.exists).toBe(true);
    expect(session.id).toBe(id);
    expect(session.has('_v')).toBe(false);
    expect(session.get('visits')).toBe(expected.visits);
    expect(Object.keys(session.all())).not.toContain('_v');
    expect(await session.save()).toBe(true);
    expect(JSON.parse((await store.read(key))!.data)).toMatchObject({ _v: 1, _token: expected._token, visits: expected.visits });
  });

  it('marks what it writes with the current format, whatever a key of that name holds', async () => {
    const store = new MemorySessionStore();
    const session = await load(store, undefined);
    session.put('theme', 'dark');
    session.put('_v', 99);
    await session.save();
    expect(JSON.parse((await store.read(sessionKey(session.id)))!.data)).toEqual({ theme: 'dark', _v: 1 });
    expect(Object.keys(session.all())).toEqual(['theme']);
  });

  it('does not keep a guest session for the mark alone', async () => {
    const store = new MemorySessionStore();
    const session = await load(store, undefined);
    expect(session.persists).toBe(false);
    expect(await session.save()).toBe(false);
    expect(await store.read(sessionKey(session.id))).toBeUndefined();
  });

  it('reads the formats it has a reader for — a synthetic second one is read, a third is foreign', () => {
    SESSION_READERS.set(2, ({ renamed, ...rest }) => ({ ...rest, theme: renamed }));
    expect(openPayload('{"theme":"dark","_v":1}')).toEqual({ kind: 'ok', data: { theme: 'dark' } });
    expect(openPayload('{"renamed":"dark","_v":2}')).toEqual({ kind: 'ok', data: { theme: 'dark' } });
    expect(openPayload('{"_v":3}')).toEqual({ kind: 'foreign' });
  });

  it('drops a payload with no usable mark — a session of the release before, a broken record — and never reads it', async () => {
    const store = new MemorySessionStore();
    const unusable = [
      '{"_auth_id":1,"_auth_password":"x","visits":9}',
      '{"_auth_id":1,"_v":"1"}',
      '{"_auth_id":1,"_v":0}',
      '{"_auth_id":1,"_v":-1}',
      '{"_auth_id":1,"_v":1.5}',
      '{"_auth_id":1,"_v":null}',
      '{"_auth_id":1,"_v":true}',
      '{"_auth_id":1,"_v":[1]}',
      '[1]',
      'null',
      'not json',
    ];
    for (const json of unusable) {
      const { id, key } = await seed(store, json);
      const before = await store.read(key);
      const session = await load(store, id);
      expect(session.id, json).not.toBe(id);
      expect(session.exists, json).toBe(false);
      expect(session.get('_auth_id'), json).toBeUndefined();
      expect(session.all(), json).toEqual({});
      expect(await session.save(), json).toBe(false);
      expect(await store.read(key), json).toEqual(before); // left to expire, not touched here
    }
  });

  it('treats a session of a newer format as no session at all, and leaves its entry exactly as it is', async () => {
    const store = new MemorySessionStore();
    const json = JSON.stringify({ _auth_id: 1, _auth_password: 'x', _auth_reauth_only: true, theme: 'dark', _v: 3 });
    const { id, key } = await seed(store, json);
    const before = await store.read(key);

    const guest = await load(store, id);
    expect(guest.exists).toBe(false);
    expect(guest.persists).toBe(false);
    expect(guest.all()).toEqual({});
    expect(guest.get('_auth_id')).toBeUndefined();
    expect(guest.id).not.toBe(id);
    guest.put('theme', 'light');
    guest.flash('status', 'x');
    guest.token();
    expect(guest.persists).toBe(false);
    expect(await guest.save()).toBe(false);
    expect(await store.read(key)).toEqual(before);

  });

  it('ends a session of a newer format when the request signs in or out — a copy of its cookie does not outlive either', async () => {
    for (const end of [(session: Session) => session.regenerate(), (session: Session) => session.invalidate()]) {
      const store = new MemorySessionStore();
      const { id, key } = await seed(store, JSON.stringify({ _auth_id: 1, theme: 'dark', _v: 3 }));
      const session = await load(store, id);
      end(session);
      session.put('_auth_id', 2);
      await session.save();
      expect(await store.read(key)).toBeUndefined();
      expect(session.ended).toContain(id);
    }
  });

  it('writes a sign-in on a session of a newer format under a new id', async () => {
    const store = new MemorySessionStore();
    const { id } = await seed(store, JSON.stringify({ _auth_id: 1, theme: 'dark', _v: 3 }));
    const session = await load(store, id);
    session.regenerate();
    session.put('_auth_id', 2);
    expect(await session.save()).toBe(true);
    expect(session.id).not.toBe(id);
    expect(JSON.parse((await store.read(sessionKey(session.id)))!.data)).toMatchObject({ _auth_id: 2, _v: 1 });
  });

  it('does not write over a session that a newer process rewrote while this request ran', async () => {
    const store = new MemorySessionStore();
    const { id, key } = await seed(store, '{"visits":1,"_v":1}');
    const session = await load(store, id);
    session.put('visits', 2);
    // The newer process writes between this request's read and its save.
    await store.write(key, '{"visits":1,"restrict":"reauth","_v":3}', { expectedVersion: 1, lifetimeSeconds: 600 });
    const before = await store.read(key);
    expect(await session.save()).toBe(false);
    expect(await store.read(key)).toEqual(before);
  });

  it('merges with a concurrent write of a format it reads, and keeps the mark out of the merge', async () => {
    const store = new MemorySessionStore();
    const { id, key } = await seed(store, '{"visits":1,"_v":1}');
    const session = await load(store, id);
    session.put('visits', 2);
    await store.write(key, '{"visits":1,"theme":"dark","_v":1}', { expectedVersion: 1, lifetimeSeconds: 600 });
    expect(await session.save()).toBe(true);
    expect(JSON.parse((await store.read(key))!.data)).toEqual({ visits: 2, theme: 'dark', _v: 1 });
  });
});

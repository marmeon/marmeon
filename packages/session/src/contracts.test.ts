import { describe, expect, it } from 'vitest';
import { SessionStore } from './store.ts';
import { DatabaseSessionStore } from './stores/database.ts';
import { FileSessionStore } from './stores/file.ts';
import { MemorySessionStore } from './stores/memory.ts';
import { RedisSessionStore } from './stores/redis.ts';
import { UserSessions } from './user-sessions.ts';

/**
 * The methods a base class implements itself, so that a store which does not override them still works — each with the reason why
 * none of the four criteria of a security-relevant member applies (docs/authentication.md#security-relevant-members). A method that
 * is added to a base class without an entry here fails this test, and the reviewer sees the classification in the diff.
 *
 * Every method of the class is abstract today (`destroyUser` is declared, not implemented), so the list is empty.
 */
const DEFAULTS: Record<string, Record<string, string>> = {
  SessionStore: {},
};

// Reflect.ownKeys sees symbol-keyed members too. A default can also be an instance field (`readonly x = async () => 0`): the instance of
// the abstract class has no own key at all, since the private mark is invisible to it.
const methodsOf = (base: abstract new () => object) => Reflect.ownKeys(base.prototype).filter((name) => name !== 'constructor');
const fieldsOf = (base: abstract new () => object) => Reflect.ownKeys(Reflect.construct(base as new () => object, []));

class PlainStore extends SessionStore {
  async read() {
    return undefined;
  }
  async write() {
    return 'written' as const;
  }
  async destroy() {}
  async gc() {
    return 0;
  }
}

describe('the contract of the session stores', () => {
  it('SessionStore has no method with a default that is not listed', () => {
    expect(methodsOf(SessionStore)).toEqual(Object.keys(DEFAULTS.SessionStore!));
    expect(fieldsOf(SessionStore), 'only the private mark, which is no own key').toEqual([]);
  });

  it('gives no store a destroyUser it did not write: a default of 0 would hide that the store cannot find a user’s sessions', async () => {
    expect('destroyUser' in PlainStore.prototype).toBe(false);
    expect('destroyUser' in new PlainStore()).toBe(false);
    expect(new UserSessions(() => new PlainStore()).canEnd()).toBe(false);
    expect(await new UserSessions(() => new PlainStore()).end(1)).toBe(0);
  });

  it.each([
    ['memory', MemorySessionStore, false],
    ['file', FileSessionStore, false],
    ['redis', RedisSessionStore, false],
    ['database', DatabaseSessionStore, true],
  ] as const)('the %s store extends SessionStore and has destroyUser only if it can find a user’s sessions', (_name, store, finds) => {
    expect(store.prototype).toBeInstanceOf(SessionStore);
    expect('destroyUser' in store.prototype).toBe(finds);
  });
});

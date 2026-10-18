// Type guarantees of `SessionStore` — checked by `tsc` (typecheck), never run.
import { SessionStore } from './store.ts';

export class CompleteStore extends SessionStore {
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

// destroyUser() stays optional: a store that cannot find a user's sessions does not have to say so
export class CompleteStoreWithUsers extends CompleteStore {
  override async destroyUser() {
    return 0;
  }
}

// @ts-expect-error write() is required: without it nothing could be stored
export class StoreWithoutWrite extends SessionStore {
  async read() {
    return undefined;
  }
  async destroy() {}
  async gc() {
    return 0;
  }
}

// @ts-expect-error a store that only implements the contract does not fit: it has to extend the class
export class StoreByImplements implements SessionStore {
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

// @ts-expect-error an object literal is no SessionStore either
export const storeLiteral: SessionStore = { read: async () => undefined, write: async () => 'written' as const, destroy: async () => {}, gc: async () => 0 };

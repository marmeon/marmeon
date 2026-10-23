import type { PasswordHash } from '../hashing.ts';
import type { Credentials, UserProvider } from '../user.ts';

/** One account of {@link MemoryUsers}: the user, the hash next to it and the session key (`null` while the account has none). */
export interface MemoryAccount<U> {
  user: U;
  hash: PasswordHash | null;
  key: string | null;
}

/**
 * Accounts in memory that keep the whole `UserProvider` contract, as an app's repository does with its table: compare-and-set on the
 * hash and on the session key, `sessionKey` handed back by both finders, every write answered with whether it wrote. A test that needs
 * something else extends it and overrides that one method; a test that needs a broken provider casts (`as never`).
 */
export class MemoryUsers<U extends { readonly id: number; readonly email?: string }> implements UserProvider<U> {
  readonly rows = new Map<number, MemoryAccount<U>>();

  /** Stores an account; returns the user for chaining. */
  add(user: U, hash: PasswordHash | null = null, key: string | null = null): U {
    this.rows.set(user.id, { user, hash, key });
    return user;
  }

  /** Runs once, after the next `findById()` has read its row — a request of another process landing at that moment. */
  after: (() => Promise<unknown>) | undefined;

  async findById(id: number): Promise<Credentials<U> | undefined> {
    const row = this.rows.get(id);
    const found = row && { user: row.user, passwordHash: row.hash, sessionKey: row.key };
    const hook = this.after;
    this.after = undefined;
    await hook?.();
    return found;
  }

  async findForSignIn(identifier: string): Promise<Credentials<U> | undefined> {
    for (const row of this.rows.values()) {
      if (row.user.email === identifier) return { user: row.user, passwordHash: row.hash, sessionKey: row.key };
    }
    return undefined;
  }

  /** With `expected` only while the stored hash is that one; with `sessionKey` the key is written together with the hash, and with `expectedSessionKey` only over that key. */
  async updatePasswordHash(id: number, hash: PasswordHash, options: { readonly expected?: PasswordHash; readonly sessionKey?: string; readonly expectedSessionKey?: string | null } = {}): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || (options.expected !== undefined && row.hash !== options.expected)) return false;
    if (options.sessionKey !== undefined && options.expectedSessionKey !== undefined && row.key !== options.expectedSessionKey) return false;
    row.hash = hash;
    if (options.sessionKey !== undefined) row.key = options.sessionKey;
    return true;
  }

  /** Compare-and-set; `expected === undefined` writes regardless of the stored key. */
  async updateSessionKey(id: number, key: string, expected: string | null | undefined): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || (expected !== undefined && row.key !== expected)) return false;
    row.key = key;
    return true;
  }

  async updateEverySessionKey(key: string): Promise<Awaited<ReturnType<UserProvider<U>['updateEverySessionKey']>>> {
    for (const row of this.rows.values()) row.key = key;
    return { accounts: this.rows.size, sampleId: this.rows.keys().next().value } as never;
  }
}

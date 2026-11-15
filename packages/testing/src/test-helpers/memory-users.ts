import type { Credentials, PasswordHash, UserProvider } from '@marmeon/auth';

/** Accounts in memory for a test of the auth helpers: the whole `UserProvider` contract, with a hash and a session key next to each user. */
export class MemoryUsers<U extends { readonly id: number; readonly email: string }> implements UserProvider<U> {
  readonly rows = new Map<number, { user: U; hash: PasswordHash | null; key: string | null }>();

  add(user: U, hash: PasswordHash | null = null): U {
    this.rows.set(user.id, { user, hash, key: null });
    return user;
  }

  async findById(id: number): Promise<Credentials<U> | undefined> {
    return this.#credentials(this.rows.get(id));
  }

  async findForSignIn(identifier: string): Promise<Credentials<U> | undefined> {
    return this.#credentials([...this.rows.values()].find((row) => row.user.email === identifier));
  }

  async updatePasswordHash(id: number, hash: PasswordHash, options: { readonly expected?: PasswordHash; readonly sessionKey?: string; readonly expectedSessionKey?: string | null } = {}): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || (options.expected !== undefined && row.hash !== options.expected)) return false;
    if (options.sessionKey !== undefined && options.expectedSessionKey !== undefined && row.key !== options.expectedSessionKey) return false;
    row.hash = hash;
    if (options.sessionKey !== undefined) row.key = options.sessionKey;
    return true;
  }

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

  #credentials(row: { user: U; hash: PasswordHash | null; key: string | null } | undefined): Credentials<U> | undefined {
    return row && { user: row.user, passwordHash: row.hash, sessionKey: row.key };
  }
}

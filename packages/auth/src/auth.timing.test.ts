import { err } from '@marmeon/core';
import { ClientHistory } from '@marmeon/http';
import type { Session } from '@marmeon/session';
import { describe, expect, it } from 'vitest';
import { Auth, PasswordHasher, type UserProvider } from './index.ts';
import { NO_CLIENT } from './test-helpers/client.ts';
import { SessionFingerprints } from './fingerprint.ts';
import { NoTwoFactorState } from './two-factor/state.ts';
import { NO_LOGIN_LIMITS } from './test-helpers/login-limits.ts';
import { signInStore } from './test-helpers/stores.ts';
import { MemoryUsers } from './test-helpers/users.ts';

const ada = { id: 1, name: 'Ada', email: 'ada@example.com' };

// Wall-clock tests run alone and last (the `timing` project), so no other test competes for the CPU. A leak is a ratio of about
// 0.02 against the bound of 0.5; `auth.test.ts` proves the same property by counting the work.
describe('the time of a failed sign-in', () => {
  it('enumeration by timing: an unknown e-mail takes as long as a wrong password', async () => {
    const users = new MemoryUsers<typeof ada>();
    const hasher = new PasswordHasher(); // real costs, so the hash dominates the time
    users.rows.set(1, { user: ada, hash: await hasher.make('secret'), key: null });
    const session = { started: true, get: () => undefined, regenerate() {}, put() {}, forget() {} } as unknown as Session;
    const auth = new Auth(session, users as unknown as UserProvider, hasher, { dispatch: async () => {} } as never, { get: () => undefined } as never, {} as never, {} as never, {} as never, new ClientHistory(), NO_CLIENT, {} as never, new NoTwoFactorState(), {} as never, signInStore(), { now: () => Date.now() } as never, new SessionFingerprints({ key: new Uint8Array(32), previousKeys: [] }), {} as never, NO_LOGIN_LIMITS);
    await auth.attempt('nobody@example.com', 'x'); // makes dummyVerify's reference hash
    const time = async (email: string) => {
      const started = performance.now();
      expect(await auth.attempt(email, 'wrong')).toStrictEqual(err({ kind: 'invalid-credentials' }));
      return performance.now() - started;
    };
    const known: number[] = [];
    const unknown: number[] = [];
    for (let i = 0; i < 7; i++) {
      known.push(await time('ada@example.com'));
      unknown.push(await time('nobody@example.com'));
    }
    const ratio = median(unknown) / median(known);
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2);
  });
});

function median(values: number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

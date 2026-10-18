// Type guarantees of `EmailChangeStore` — checked by `tsc` (typecheck), never run.
import { expectTypeOf } from 'vitest';
import { EmailChangeStore } from './email-changes.ts';
import type { AuthUserId } from './user.ts';

export class CompleteChanges extends EmailChangeStore {
  async create() {
    return 'token';
  }
  async pending() {
    return undefined;
  }
  async waiting() {
    return undefined;
  }
  async claim() {
    return undefined;
  }
  async forget() {}
  async prune() {
    return 0;
  }
  async forgetEveryone() {
    return 0;
  }
}
// @ts-expect-error forgetEveryone() is required: without it the emergency switch would leave a change of address alive
export class ChangesWithoutForgetEveryone extends EmailChangeStore {
  async create() {
    return 'token';
  }
  async pending() {
    return undefined;
  }
  async waiting() {
    return undefined;
  }
  async claim() {
    return undefined;
  }
  async forget() {}
  async prune() {
    return 0;
  }
}
// @ts-expect-error claim() is required: without it no link could be used up exactly once
export class ChangesWithoutClaim extends EmailChangeStore {
  async create() {
    return 'token';
  }
  async pending() {
    return undefined;
  }
  async waiting() {
    return undefined;
  }
  async forget() {}
  async prune() {
    return 0;
  }
  async forgetEveryone() {
    return 0;
  }
}
// @ts-expect-error a store that only implements the contract does not fit: it has to extend the class
export class ChangesByImplements implements EmailChangeStore {
  async create() {
    return 'token';
  }
  async pending() {
    return undefined;
  }
  async waiting() {
    return undefined;
  }
  async claim() {
    return undefined;
  }
  async forget() {}
  async prune() {
    return 0;
  }
  async forgetEveryone() {
    return 0;
  }
}
// @ts-expect-error an object literal is no EmailChangeStore either
export const changesLiteral: EmailChangeStore = {
  create: async () => 'token',
  pending: async () => undefined,
  waiting: async () => undefined,
  claim: async () => undefined,
  forget: async () => {},
  prune: async () => 0,
  forgetEveryone: async () => 0,
};

export function storeTakesTheAppsUserId() {
  expectTypeOf<Parameters<EmailChangeStore['create']>[0]>().toEqualTypeOf<AuthUserId>();
  expectTypeOf<Parameters<EmailChangeStore['pending']>[0]>().toEqualTypeOf<AuthUserId>();
  expectTypeOf<Parameters<EmailChangeStore['waiting']>[0]>().toEqualTypeOf<AuthUserId>();
  expectTypeOf<Parameters<EmailChangeStore['claim']>[0]>().toEqualTypeOf<AuthUserId>();
  expectTypeOf<Parameters<EmailChangeStore['forget']>[0]>().toEqualTypeOf<AuthUserId>();
}

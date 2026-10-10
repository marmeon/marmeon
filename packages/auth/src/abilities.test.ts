import { describe, expect, it } from 'vitest';
import { deny, denyAsNotFound, Gate, type Auth, type AuthUser } from './index.ts';

interface Post {
  id: number;
  authorId: number;
  draft: boolean;
}

/** How often each part of the policy ran — the projection's cost, counted. */
interface Calls {
  built: number;
  before: string[];
  update: number;
  publish: number;
  view: number;
  create: number;
}

const counting = (calls: Calls, { admin = false } = {}) =>
  class CountingPostPolicy {
    constructor() {
      calls.built++;
    }
    before(_user: AuthUser, ability: string) {
      calls.before.push(ability);
      return admin ? true : undefined;
    }
    update(user: AuthUser, post: Post) {
      calls.update++;
      return post.authorId === user.id || deny('Only the author can edit this post.');
    }
    async publish(user: AuthUser, post: Post) {
      calls.publish++;
      return post.draft && post.authorId === user.id;
    }
    view(user: AuthUser, post: Post) {
      calls.view++;
      return !post.draft || post.authorId === user.id ? true : denyAsNotFound();
    }
    create(user: AuthUser) {
      calls.create++;
      return user.id !== 3;
    }
  };

const ada: AuthUser = { id: 1, name: 'Ada', email: 'ada@example.com' };

function gateFor(user: AuthUser | undefined, { admin = false } = {}) {
  const calls: Calls = { built: 0, before: [], update: 0, publish: 0, view: 0, create: 0 };
  const Policy = counting(calls, { admin });
  const auth = { user: async () => user } as unknown as Auth;
  const gate = new Gate(auth, (Class) => new Class());
  return { gate, Policy, calls };
}

const post = (id: number, authorId: number, draft = false): Post => ({ id, authorId, draft });

describe('Gate.abilities — an explicit projection', () => {
  it('answers one boolean per named ability — never the reason of a denial', async () => {
    const { gate, Policy } = gateFor(ada);
    const answer = await gate.abilities(post(1, 2, true), Policy, ['update', 'view', 'publish']);
    expect(answer).toEqual({ update: false, view: false, publish: false });
    expect(await gate.abilities(post(2, 1, true), Policy, ['update', 'view', 'publish'])).toEqual({ update: true, view: true, publish: true });
    // `deny('…')` and `denyAsNotFound()` are a `false` here: what leaves the server is a boolean.
    expect(JSON.stringify(answer)).not.toContain('author');
    expect(Object.values(answer).every((value) => typeof value === 'boolean')).toBe(true);
  });

  it('is lazy: nothing runs until it is asked for — then once, however often it is asked', async () => {
    const { gate, Policy, calls } = gateFor(ada);
    const projection = gate.abilities(post(1, 1), Policy, ['update']);
    await Promise.resolve();
    expect(calls).toEqual({ built: 0, before: [], update: 0, publish: 0, view: 0, create: 0 });
    // As a page prop, the response factory calls it; anywhere else it is awaited — the same answer, computed once.
    expect(await projection()).toEqual({ update: true });
    expect(await projection).toEqual({ update: true });
    expect(calls.update).toBe(1);
  });

  it('asks only what it names — no ability that is not named runs (no implicit can())', async () => {
    const { gate, Policy, calls } = gateFor(ada);
    await gate.abilities(post(1, 1), Policy, ['update']);
    expect(calls).toEqual({ built: 1, before: ['update'], update: 1, publish: 0, view: 0, create: 0 });
  });

  it('projects abilities without a resource', async () => {
    const { gate, Policy, calls } = gateFor({ id: 3, name: 'Banned', email: 'banned@example.com' });
    expect(await gate.abilities(Policy, ['create'])).toEqual({ create: false });
    expect(calls.create).toBe(1);
  });

  it('denies a guest everything — without building the policy', async () => {
    const { gate, Policy, calls } = gateFor(undefined);
    expect(await gate.abilities(post(1, 1), Policy, ['update', 'view'])).toEqual({ update: false, view: false });
    expect(await gate.withAbilities([post(1, 1)], Policy, ['update'])).toEqual([{ ...post(1, 1), can: { update: false } }]);
    expect(calls.built).toBe(0);
  });

  it('lets before() decide — the abilities themselves do not run then', async () => {
    const { gate, Policy, calls } = gateFor(ada, { admin: true });
    expect(await gate.withAbilities([post(1, 2), post(2, 2)], Policy, ['update', 'publish'])).toEqual([
      { ...post(1, 2), can: { update: true, publish: true } },
      { ...post(2, 2), can: { update: true, publish: true } },
    ]);
    expect(calls).toMatchObject({ before: ['update', 'publish'], update: 0, publish: 0 });
  });

  it('refuses an unknown ability (past the types) before asking anything', async () => {
    const { gate, Policy, calls } = gateFor(ada);
    const names = ['update', 'destroy'] as unknown as 'update'[];
    await expect(gate.abilities(post(1, 1), Policy, names)).rejects.toThrow('has no ability "destroy"');
    expect(calls.update).toBe(0);
  });
});

describe('Gate.withAbilities — each row with its abilities', () => {
  it('adds `can` to every row and keeps the row as it was', async () => {
    const { gate, Policy } = gateFor(ada);
    const rows = [post(1, 1), post(2, 2)];
    expect(await gate.withAbilities(rows, Policy, ['update'])).toEqual([
      { id: 1, authorId: 1, draft: false, can: { update: true } },
      { id: 2, authorId: 2, draft: false, can: { update: false } },
    ]);
    expect(rows[0]).not.toHaveProperty('can'); // a copy: the rows themselves stay as they were
  });

  it('costs, for 50 rows: the policy method 50 times — before() once, the policy built once, nothing not named', async () => {
    const { gate, Policy, calls } = gateFor(ada);
    const rows = Array.from({ length: 50 }, (_, index) => post(index + 1, (index % 2) + 1));
    const answer = await gate.withAbilities(rows, Policy, ['update']);
    expect(answer.filter((row) => row.can.update)).toHaveLength(25);
    expect(calls).toEqual({ built: 1, before: ['update'], update: 50, publish: 0, view: 0, create: 0 });
  });

  it('asks nothing for no rows', async () => {
    const { gate, Policy, calls } = gateFor(ada);
    expect(await gate.withAbilities([], Policy, ['update'])).toEqual([]);
    expect(calls.built).toBe(0);
  });
});

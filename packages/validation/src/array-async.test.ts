import type { StandardSchemaV1 } from '@marmeon/core';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { arrayEngine, ITEM_CONCURRENCY, type Engine } from './engine.ts';
import { rules as r } from './index.ts';

type Result = { value?: unknown; issues?: readonly { message: string; path?: readonly { key?: unknown }[] }[] };

const inRequest = (schema: StandardSchemaV1, value: unknown, live = false) =>
  schema['~standard'].validate(value, { libraryOptions: { marmeon: { resolve: (C: any) => new C(), ctx: {} as never, live } } } as never) as Promise<Result>;

/** A repository whose rows all exist — it counts the queries it was asked. */
function lookup() {
  const counter = { queries: 0, running: 0, peak: 0 };
  class Lookup {
    query() {
      const chain = {
        select: () => chain,
        where: () => chain,
        limit: () => chain,
        executeTakeFirst: async () => {
          counter.queries++;
          counter.running++;
          counter.peak = Math.max(counter.peak, counter.running);
          await new Promise((resolve) => setTimeout(resolve, 1));
          counter.running--;
          return { id: 1 };
        },
      };
      return chain;
    }
  }
  return { counter, Lookup };
}

describe('a list is sized before its items are checked', () => {
  it('50 000 ids with a max of 10 ask the database nothing', async () => {
    const { counter, Lookup } = lookup();
    const schema = r.object({ tags: r.array(r.integer().exists(Lookup, 'id')).max(10) });
    const result = await inRequest(schema, { tags: Array.from({ length: 50_000 }, () => 1) });
    expect(result.issues?.map((issue) => issue.message)).toEqual(['The tags field must not have more than 10 items.']);
    expect(counter.queries).toBe(0);
  });

  it('min and between go first too, and a list within its size is checked item by item', async () => {
    const { counter, Lookup } = lookup();
    const few = r.array(r.integer().exists(Lookup, 'id')).min(3);
    expect((await inRequest(few, [1, 2])).issues?.[0]?.message).toBe('The value field must have at least 3 items.');
    const between = r.array(r.integer().exists(Lookup, 'id')).between(1, 2);
    expect((await inRequest(between, [1, 2, 3])).issues).toHaveLength(1);
    expect(counter.queries).toBe(0);
    expect((await inRequest(between, [1, 2])).issues).toBeUndefined();
    expect(counter.queries).toBe(2);
  });

  it('a list that is no list is still "must be a list", and r.list() sizes its split items first', async () => {
    const { counter, Lookup } = lookup();
    expect((await inRequest(r.array(r.integer()).max(1), 'x')).issues?.[0]?.message).toBe('The value field must be a list.');
    const emails = r.list(r.string().exists(Lookup, 'id')).max(2);
    expect((await inRequest(emails, 'a, b, c')).issues?.[0]?.message).toBe('The value field must not have more than 2 items.');
    expect(counter.queries).toBe(0);
    expect((await inRequest(emails, 'a, b')).issues).toBeUndefined();
    expect(counter.queries).toBe(2);
  });

  it('a synchronous list is sized first as well', () => {
    let seen = 0;
    const schema = r.array(r.string().custom(() => (seen++, true))).max(2);
    const result = schema['~standard'].validate(['a', 'b', 'c']) as Result;
    expect(result.issues).toHaveLength(1);
    expect(seen).toBe(0);
  });

  it('a live validation takes the same path', async () => {
    const { counter, Lookup } = lookup();
    const schema = r.object({ tags: r.array(r.integer().exists(Lookup, 'id').live()).max(2) });
    const result = await inRequest(schema, { tags: [1, 2, 3, 4] }, true);
    expect(result.issues).toHaveLength(1);
    expect(counter.queries).toBe(0);
    expect((await inRequest(schema, { tags: [1, 2] }, true)).issues).toBeUndefined();
    expect(counter.queries).toBe(2);
  });
});

describe('asynchronous items run a few at a time', () => {
  it(`100 items are checked at most ${ITEM_CONCURRENCY} at once`, async () => {
    let running = 0;
    let peak = 0;
    const schema = r.array(
      r.string().custom(async () => {
        peak = Math.max(peak, ++running);
        await new Promise((resolve) => setTimeout(resolve, 1));
        running--;
        return true;
      }),
    );
    const result = await schema['~standard'].validate(Array.from({ length: 100 }, (_, index) => String(index)));
    expect((result as Result).issues).toBeUndefined();
    expect((result as { value: unknown }).value).toHaveLength(100);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(ITEM_CONCURRENCY);
  });
});

describe('a failing item check ends the list', () => {
  it('starts no item after the one that threw', async () => {
    let started = 0;
    const schema = r.array(
      r.string().custom(async (value) => {
        started++;
        await new Promise((resolve) => setTimeout(resolve, 2));
        if (value === '0') throw new Error('database gone');
        return true;
      }),
    );
    await expect(schema['~standard'].validate(Array.from({ length: 200 }, (_, index) => String(index)))).rejects.toThrow('database gone');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(started).toBeLessThanOrEqual(ITEM_CONCURRENCY);
  });

  /** Items that count their starts; "boom" rejects after a moment. */
  const counting = () => {
    const counter = { started: 0 };
    const rule = r.string().custom(async (value) => {
      counter.started++;
      await new Promise((resolve) => setTimeout(resolve, 2));
      if (value === 'boom') throw new Error('database gone');
      return true;
    });
    return { counter, rule };
  };
  const filler = (count: number) => Array.from({ length: count }, () => 'ok');

  it('stops the lists around it too: nested lists', async () => {
    const { counter, rule } = counting();
    const schema = r.array(r.array(rule));
    await expect(schema['~standard'].validate([['boom'], ...Array.from({ length: 7 }, () => filler(50))])).rejects.toThrow('database gone');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(counter.started).toBeLessThanOrEqual(ITEM_CONCURRENCY * 8);
  });

  it('stops the lists around it too: a sibling field', async () => {
    const { counter, rule } = counting();
    const schema = r.object({ first: r.array(rule), tags: r.array(rule) });
    await expect(schema['~standard'].validate({ first: ['boom', ...filler(100)], tags: filler(200) })).rejects.toThrow('database gone');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(counter.started).toBeLessThanOrEqual(ITEM_CONCURRENCY * 2);
  });

  it('ends only the validation that failed — a later one checks all its items (Valibot hands each parse a config of its own)', async () => {
    const { counter, rule } = counting();
    const schema = r.array(rule);
    await expect(schema['~standard'].validate(['boom', ...filler(20)])).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 20));
    counter.started = 0;
    expect(((await schema['~standard'].validate(filler(30))) as Result).issues).toBeUndefined();
    expect(counter.started).toBe(30);
  });
});

describe('the item engine answers as the engine of Valibot does', () => {
  const small = v.pipeAsync(
    v.string(),
    v.checkAsync(async (value) => {
      await new Promise((resolve) => setTimeout(resolve, value === 'slow' ? 5 : 0));
      return value !== 'bad';
    }, 'bad one'),
    v.transform((value) => value.toUpperCase()),
  );
  const shape = (issues: readonly { message: string; path?: readonly { key?: unknown; type?: unknown; origin?: unknown }[] }[] | undefined) =>
    issues?.map((issue) => ({ message: issue.message, path: issue.path?.map(({ key, type, origin }) => [type, origin, key]) }));

  for (const [name, input] of [
    ['valid', ['a', 'slow', 'b']],
    ['mixed', ['a', 'bad', 3, 'slow', 'bad', null]],
    ['empty', []],
  ] as const) {
    it(name, async () => {
      const ours = await v.safeParseAsync(arrayEngine(small as unknown as Engine, true) as never, input, { abortPipeEarly: true });
      const theirs = await v.safeParseAsync(v.arrayAsync(small), input, { abortPipeEarly: true });
      expect(ours.success).toBe(theirs.success);
      expect(ours.output).toEqual(theirs.output);
      expect(shape(ours.issues as never)).toEqual(shape(theirs.issues as never));
    });
  }
});

import { describe, expect, expectTypeOf, it } from 'vitest';
import { Controller } from './controller.ts';
import type { PageProps, Serialize } from './view.ts';

// Type guarantees of `Serialize` — each checked against what JSON really does at runtime.
const roundTrip = <T>(value: T) => JSON.parse(JSON.stringify(value)) as Serialize<T>;

describe('Serialize<T>', () => {
  it('types values as they arrive after JSON', () => {
    const value = {
      at: new Date('2026-10-01T12:00:00.000Z'),
      name: 'Ada',
      nickname: undefined as string | undefined,
      gone: undefined,
      greet: () => 'hi',
      tags: ['a', undefined, () => 1] as (string | undefined | (() => number))[],
      nested: { when: new Date(0), count: 1, flag: true, none: null },
      meta: new Map([['a', 1]]),
      json: { theme: 'dark' } as unknown,
    };
    const arrived = roundTrip(value);
    expect(arrived).toEqual({
      at: '2026-10-01T12:00:00.000Z',
      name: 'Ada',
      tags: ['a', null, null],
      nested: { when: '1970-01-01T00:00:00.000Z', count: 1, flag: true, none: null },
      meta: {},
      json: { theme: 'dark' },
    });
    expectTypeOf(arrived).toEqualTypeOf<{
      at: string;
      name: string;
      nickname?: string;
      tags: (string | null)[];
      nested: { when: string; count: number; flag: boolean; none: null };
      meta: {};
      json?: unknown; // `unknown` may be undefined — then JSON drops it
    }>();
    // @ts-expect-error — (1) a Date prop is a string in the view, not a Date
    expectTypeOf(arrived.at).toEqualTypeOf<Date>();
    // @ts-expect-error — (2) functions do not survive JSON
    void arrived.greet;
  });

  it('refuses bigint (JSON.stringify throws) and keeps tuples', () => {
    expect(() => JSON.stringify({ n: 1n })).toThrow(TypeError);
    expectTypeOf<Serialize<{ n: bigint }>>().toEqualTypeOf<{ n: never }>();
    expectTypeOf<Serialize<readonly [Date, number]>>().toEqualTypeOf<[string, number]>();
  });

  it('types page props as they arrive', () => {
    class ShowEventController extends Controller {
      handle() {
        return this.view('events/Show', { startsAt: new Date(), title: 'Launch', note: undefined as string | undefined });
      }
    }
    type Props = PageProps<ShowEventController>;
    expectTypeOf<Props['startsAt']>().toEqualTypeOf<string>();
    expectTypeOf<Props['note']>().toEqualTypeOf<string | undefined>(); // optional after JSON
    // @ts-expect-error — (3) calling a Date method on what is a string in the view
    void ((props: Props) => props.startsAt.getTime());
  });
});

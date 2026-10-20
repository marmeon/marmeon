import { describe, expect, it } from 'vitest';
import { defineMiddleware } from './middleware.ts';
import { ensuresOf } from './ensures.ts';

describe('ensuresOf', () => {
  it('reads the promises of a class, an object and a class that inherits them', () => {
    class Limited {
      static ensures = ['rate-limited'] as const;
      handle = (_ctx: unknown, next: () => Response) => next();
    }
    class Child extends Limited {}
    expect(ensuresOf(Limited as never)).toEqual(['rate-limited']);
    expect(ensuresOf(Child as never)).toEqual(['rate-limited']);
    expect(ensuresOf(Object.assign(defineMiddleware('x', (_ctx, next) => next()), { ensures: ['authenticated', 'rate-limited'] }))).toEqual(['authenticated', 'rate-limited']);
  });

  it('counts an array of known strings only', () => {
    const declared = (ensures: unknown) => ensuresOf(Object.assign(class {}, { ensures }) as never);
    expect(declared('rate-limited')).toEqual([]);
    expect(declared(['trusted'])).toEqual([]);
    expect(declared([42, null, {}])).toEqual([]);
    expect(declared({ 0: 'rate-limited', length: 1 })).toEqual([]);
    expect(declared(['trusted', 'authenticated'])).toEqual(['authenticated']);
    expect(ensuresOf(class {} as never)).toEqual([]);
  });

  it('survives a getter that throws', () => {
    const Hostile = class {
      static get ensures(): never {
        throw new Error('no');
      }
    };
    expect(ensuresOf(Hostile as never)).toEqual([]);
  });
});

import { describe, expectTypeOf, it } from 'vitest';
import type { FetchOptions } from './client.ts';
import type { FetchDriverFactory, FetchTransport } from './transport.ts';

describe('fetch types', () => {
  it('takes body or json, never both', () => {
    expectTypeOf<{ body: string }>().toExtend<FetchOptions>();
    expectTypeOf<{ json: { a: 1 } }>().toExtend<FetchOptions>();
    // @ts-expect-error body and json together do not compile
    const both: FetchOptions = { body: 'x', json: {} };
    expectTypeOf(both).toBeObject();
  });

  it('takes a known redirect mode only', () => {
    // @ts-expect-error 'nope' is no redirect mode
    const options: FetchOptions = { redirect: 'nope' };
    expectTypeOf(options).toBeObject();
  });

  it('a driver factory returns a transport, not an empty object or a promise', () => {
    // @ts-expect-error an empty object has no send()
    const empty: FetchDriverFactory = () => ({});
    // @ts-expect-error a factory is synchronous
    const later: FetchDriverFactory = async () => ({}) as FetchTransport;
    expectTypeOf(empty).toBeFunction();
    expectTypeOf(later).toBeFunction();
  });
});

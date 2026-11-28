// Type guarantees of `static searchDrivers` on a provider — checked by `tsc` (pnpm build / typecheck), never run.
import type { ServiceProviderClass } from '@marmeon/core';
import { describe, it } from 'vitest';
import type { SearchDriver, SearchDriverContext } from './driver.ts';
import './provider.ts';

declare const driver: SearchDriver;

describe('static searchDrivers', () => {
  it('takes factories by name, and refuses a value that is no factory, a factory of another context or one that returns no driver', () => {
    const fine: ServiceProviderClass = class {
      static searchDrivers = { typesense: (context: SearchDriverContext) => (context.name === 'typesense' ? driver : driver) };
      boot(): void {}
    };
    // @ts-expect-error — the factory returns a SearchDriver: writes, upsert(), delete(), query() and flush().
    const shape: ServiceProviderClass = class {
      static searchDrivers = { typesense: (context: SearchDriverContext) => ({ name: context.name }) };
      boot(): void {}
    };
    // @ts-expect-error — a driver is created by a function, not given as a value.
    const value: ServiceProviderClass = class {
      static searchDrivers = { typesense: 42 };
      boot(): void {}
    };
    // @ts-expect-error — the factory is given a SearchDriverContext, not a number.
    const context: ServiceProviderClass = class {
      static searchDrivers = { typesense: (port: number) => (port > 0 ? driver : driver) };
      boot(): void {}
    };
    void [fine, shape, value, context];
  });
});

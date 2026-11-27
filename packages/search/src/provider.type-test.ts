// Type guarantees of `static searchDrivers` on a provider — checked by `tsc` (pnpm build / typecheck), never run.
import type { ServiceProviderClass } from '@marmeon/core';
import { describe, it } from 'vitest';
import type { SearchDriverContext } from './driver.ts';
import './provider.ts';

describe('static searchDrivers', () => {
  it('takes factories by name, and refuses a value that is no factory or a factory of another context', () => {
    const fine: ServiceProviderClass = class {
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
      static searchDrivers = { typesense: (port: number) => ({ port }) };
      boot(): void {}
    };
    void [fine, value, context];
  });
});

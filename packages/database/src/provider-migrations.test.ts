import type { ServiceProviderClass } from '@marmeon/core';
import { expect, it } from 'vitest';
import './provider.ts';

// The type of `static migrations` comes from this package, by declaration merging into `ServiceProviderClass`.
it('static migrations takes a file URL and a module, and nothing else', () => {
  const directory = new URL('../stubs/migrations', import.meta.url);
  const providers: ServiceProviderClass[] = [
    class {
      static migrations = { from: directory, module: 'things' };
    },
    // @ts-expect-error from is a URL, not a path
    class {
      static migrations = { from: 'stubs/migrations', module: 'things' };
    },
    // @ts-expect-error module is required
    class {
      static migrations = { from: directory };
    },
    // @ts-expect-error a list of directories is not declared
    class {
      static migrations = [{ from: directory, module: 'things' }];
    },
  ];
  expect(providers).toHaveLength(4);
});

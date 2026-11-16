import { defineConfig, env, type ConfigOf } from '@marmeon/core';

/** The built-in transports; a provider can bring more (`static fetchDrivers`). */
export const BUILT_IN_FETCH_DRIVERS = ['direct'] as const;

export const FetchConfig = defineConfig('fetch', {
  env: env({
    /** `direct` (default: resolves, checks and connects itself) or a transport a provider brings. A name nobody brought stops the start. */
    FETCH_DRIVER: env.string().regex(/^[a-z][a-z0-9-]*$/, 'must be a driver name: lowercase letters, digits and dashes').default('direct'),
    /**
     * Address ranges (CIDR, comma-separated: `10.20.0.0/16,fd00::/8`) that outgoing requests may reach although they are not public.
     * Empty by default: no environment allows loopback or a private network by itself.
     */
    FETCH_ALLOWED_ADDRESSES: env.string().default(''),
  }),
  resolve: (e) => ({
    driver: e.FETCH_DRIVER,
    /** The entries as written; the provider parses them at the start and refuses a malformed one. */
    allowedAddresses: e.FETCH_ALLOWED_ADDRESSES.trim() === '' ? [] : e.FETCH_ALLOWED_ADDRESSES.split(',').map((entry) => entry.trim()),
  }),
});
export type FetchConfig = ConfigOf<typeof FetchConfig>;

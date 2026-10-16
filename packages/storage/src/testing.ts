/**
 * Test doubles for apps' tests — see `docs/fakes.md#storage`. `createTestApp()` puts a `StorageFake` in as the `Storage`, so an
 * app imports it only to type a variable.
 */
export { StorageFake } from './fake.ts';
export type { FakeDisk } from './fake.ts';

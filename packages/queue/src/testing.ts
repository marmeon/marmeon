/**
 * Test doubles for apps' tests — see `docs/fakes.md#queue`. `createTestApp()` puts a `QueueFake` in as the `Queue`, so an app
 * imports it only to type a variable.
 */
export { QueueFake } from './fake.ts';
export type { ChainMatch, DispatchedJob, DispatchedUnique, DispatchMatch } from './fake.ts';

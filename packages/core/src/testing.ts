/**
 * Test doubles for an app's tests: the events' fake (`docs/fakes.md#events`) and the clock a test moves
 * (`docs/time.md#moving-the-clock`). `createTestApp` of `@marmeon/testing` binds both.
 */
export { TestClock } from './clock.ts';
export { EventFake } from './events-fake.ts';
export type { EventMatch } from './events-fake.ts';

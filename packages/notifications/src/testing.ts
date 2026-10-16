/**
 * Test doubles for an app's tests: the notification service that records what is sent (`docs/fakes.md#notifications`).
 * `createTestApp` of `@marmeon/testing` binds it as `app.notifications`.
 */
export { NotificationFake } from './fake.ts';
export type { NotificationMatch, SentNotification } from './fake.ts';

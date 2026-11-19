/**
 * Test doubles for an app's tests: the chat notifier that records messages instead of posting them. Build it with
 * `new ChatFake(app.container)`.
 */
export { ChatFake } from './fake.ts';
export type { ChatMatch, RecordedChatMessage } from './fake.ts';

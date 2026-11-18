/**
 * Test doubles for an app's tests: the chat notifier that records messages instead of posting them — `app.chat` of a test app
 * (`@marmeon/testing`). See `docs/fakes.md#chat`.
 */
export { ChatFake } from './fake.ts';
export type { ChatMatch, RecordedChatMessage } from './fake.ts';

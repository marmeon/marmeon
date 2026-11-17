/**
 * Test doubles for an app's tests: the client that answers outgoing requests from replies (`docs/http-client.md#testing`).
 * `createTestApp` of `@marmeon/testing` binds it as `app.http`.
 */
export { HttpClientFake } from './fake.ts';
export type { FakeReply, RequestMatch } from './fake.ts';

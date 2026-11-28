/**
 * Test doubles for an app's tests: the search driver that keeps every index in memory and records every write — `app.search` of a
 * test app (`@marmeon/testing`). See `docs/full-text-search.md#testing`.
 */
export { SearchFake } from './fake.ts';
export type { RecordedSearchWrite } from './fake.ts';

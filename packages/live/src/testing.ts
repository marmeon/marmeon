/**
 * `@marmeon/live/testing` — what a test reads of the live updates. `createTestApp()` makes the recorder (`app.broadcast`) and
 * the reader (`app.live(path)`); an app imports them only to type a variable. See `docs/realtime.md#testing`.
 */
export { BroadcastRecorder } from './recorder.ts';
export type { RecordedRefresh } from './recorder.ts';
export { LiveStreamReader } from './test-stream.ts';
export type { LiveEvent } from './test-stream.ts';

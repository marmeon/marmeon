import { token, type CurrentRequest } from '@marmeon/core';
import type { DbQueryMessage, LogMessage } from '@marmeon/core/diagnostics';

/** What the error page shows of a request's queries and log entries — raw; the page redacts them. */
export interface RequestRecording {
  readonly queries: readonly DbQueryMessage[];
  /** Queries left out once {@link MAX_RECORDED} were kept. */
  readonly droppedQueries: number;
  readonly logs: readonly LogMessage[];
  readonly droppedLogs: number;
}

/**
 * The error page's request recorder (development only): from the moment a request starts, its queries and log
 * entries — by the request's own context, so a parallel request's never mix in. Bound by the server's provider only when
 * `ServerConfig.debug`; the kernel asks for it with `has`.
 */
export interface RequestRecorder {
  /** Starts recording the request whose context is `info`. */
  begin(info: CurrentRequest): void;
  /** What was recorded for the request of `info` so far. */
  recording(info: CurrentRequest): RequestRecording | undefined;
  /** Stops listening (the provider's `shutdown`). */
  close(): void;
}
export const DevRequestRecorder = token<RequestRecorder>('DevRequestRecorder');

/** Queries and log entries kept per request (the first ones — the rest is counted). */
export const MAX_RECORDED = 100;

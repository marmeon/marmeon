import { AsyncLocalStorage } from 'node:async_hooks';

/** What every log entry of a request carries. */
export interface RequestInfo {
  readonly requestId: string;
}

// The one deliberate piece of ambient state (decision E3): request-bound data for
// cross-cutting concerns like logging, so a logger needs no request passed around.
const storage = new AsyncLocalStorage<RequestInfo>();

/** Runs `fn` with `info` as the current request — set by the HTTP kernel per request. */
export function runWithRequest<T>(info: RequestInfo, fn: () => T): T {
  return storage.run(info, fn);
}

/** The request currently being handled, if any. */
export function currentRequest(): RequestInfo | undefined {
  return storage.getStore();
}

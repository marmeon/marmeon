/**
 * Runs a log call whose failure must not cost the caller the work after it (a reporter's report, a job's `failed()` and
 * `JobFailed`). A `Logger` returns nothing and does not throw, but a sink that does either (a throwing `error()`, an
 * `async error()` that rejects) is tolerated: a throw is swallowed and a returned promise is consumed, so its rejection is handled.
 */
export function guardedLog(write: () => unknown): void {
  try {
    Promise.resolve(write()).catch(() => undefined);
  } catch {
    // A sink that throws is skipped.
  }
}

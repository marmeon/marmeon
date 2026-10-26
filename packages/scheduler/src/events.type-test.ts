// What a scheduler event and a run call the time a task was due — checked by `tsc` (pnpm build / typecheck), never run.
import type { ScheduledTaskEvent, TaskResult, TaskRun } from './index.ts';

export function due(event: ScheduledTaskEvent, result: TaskResult, run: TaskRun): number[] {
  // @ts-expect-error — the time it was due is `dueAt`
  void event.minute;
  // @ts-expect-error — in a result too
  void result.minute;
  // @ts-expect-error — and in a run
  void run.minute;
  return [event.dueAt, result.dueAt, run.dueAt];
}

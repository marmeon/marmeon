// The spans and the read-only definition of a task — checked by `tsc` (pnpm build / typecheck), never run.
import { defineSchedule, type CallableTaskClass, type Scheduler } from './index.ts';

declare const Task: CallableTaskClass;
declare const scheduler: Scheduler;

export const Spans = defineSchedule((s) => {
  s.call(Task).hourly().withoutOverlapping();
  s.call(Task).hourly().withoutOverlapping({ expiresAfter: { minutes: 30 } });
  s.call(Task).hourly().withoutOverlapping({ expiresAfter: 1800 });
  // @ts-expect-error — the lock's span is an option now: withoutOverlapping({ expiresAfter: { minutes: 30 } })
  s.call(Task).hourly().withoutOverlapping(30);
  // @ts-expect-error — the option is called expiresAfter
  s.call(Task).hourly().withoutOverlapping({ expiresAfterMinutes: 30 });
  s.call(Task).daily().timeZone('Europe/Berlin');
  // @ts-expect-error — the method is timeZone()
  s.call(Task).daily().timezone('Europe/Berlin');
});

export function ReadOnly() {
  const { definition } = scheduler.tasks[0]!;
  // @ts-expect-error — a task is changed through its builder, not through what it was collected into
  definition.onOneServer = true;
  // @ts-expect-error — the lists are read-only too
  definition.when.push(() => true);
  // @ts-expect-error — and the cron fields
  definition.fields![0] = '*';
  // @ts-expect-error — `timezone` is `timeZone`
  return definition.timezone;
}

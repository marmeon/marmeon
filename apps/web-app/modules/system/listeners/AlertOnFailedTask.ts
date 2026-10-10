import { Logger, Redactor } from '@marmeon/core';
import type { ScheduledTaskFailed } from '@marmeon/scheduler';

/**
 * A scheduled task failed: one error entry with `alert: true` on the `alerts` channel — what a log shipper pages
 * someone for (the scheduler's own `Failed: …` line is for reading the log, this one is for acting on it). The error's
 * message is masked by the app's Redactor: it may quote a secret or a cookie header (the session cookie's name counts too).
 */
export class AlertOnFailedTask {
  readonly #logger: Logger;
  readonly #redactor: Redactor;

  constructor(logger: Logger, redactor: Redactor) {
    this.#logger = logger.child({ channel: 'alerts' });
    this.#redactor = redactor;
  }

  handle(event: ScheduledTaskFailed): void {
    const message = event.error instanceof Error ? `${event.error.name}: ${event.error.message}` : String(event.error);
    this.#logger.error(`The scheduled task ${event.task} failed: ${this.#redactor.text(message)}`, {
      alert: true,
      task: event.task,
      due: new Date(event.minute).toISOString(),
      ms: event.ms,
    });
  }
}

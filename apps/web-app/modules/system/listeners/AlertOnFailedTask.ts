import { Logger, redactText } from '@marmeon/core';
import type { ScheduledTaskFailed } from '@marmeon/scheduler';

/**
 * A scheduled task failed (E127): one error entry with `alert: true` on the `alerts` channel — what a log shipper pages
 * someone for (the scheduler's own `Failed: …` line is for reading the log, this one is for acting on it). The error's
 * message is redacted: it may quote a secret.
 */
export class AlertOnFailedTask {
  readonly #logger: Logger;

  constructor(logger: Logger) {
    this.#logger = logger.child({ channel: 'alerts' });
  }

  handle(event: ScheduledTaskFailed): void {
    const message = event.error instanceof Error ? `${event.error.name}: ${event.error.message}` : String(event.error);
    this.#logger.error(`The scheduled task ${event.task} failed: ${redactText(message)}`, {
      alert: true,
      task: event.task,
      due: new Date(event.minute).toISOString(),
      ms: event.ms,
    });
  }
}

import type { ErrorReport, ErrorReporter } from '@marmeon/core';

/** How many reports it keeps. */
const CAPACITY = 20;

/**
 * An error reporter in its smallest form: keeps the last {@link CAPACITY} server errors, as the reporters get them (masked), in
 * the process's memory. A real reporter sends them to a service instead; the lab lists these on `/lab/errors`.
 */
export class RecentErrors implements ErrorReporter {
  readonly #reports: ErrorReport[] = [];

  report(report: ErrorReport): void {
    this.#reports.push(report);
    if (this.#reports.length > CAPACITY) this.#reports.shift();
  }

  /** The kept reports, the newest first. */
  recent(): readonly ErrorReport[] {
    return this.#reports.toReversed();
  }
}

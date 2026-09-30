import { Clock } from '@acme/clock';
import type { Mailer } from './mailer.js';
import { Formatter } from './formatter.js';

export class SmtpMailer implements Mailer {
  readonly #clock: Clock;
  readonly #formatter: Formatter;
  readonly retries: number;

  // `retries` is optional: the injection list ends before it, so the default applies.
  constructor(clock: Clock, formatter: Formatter, retries = 3) {
    this.#clock = clock;
    this.#formatter = formatter;
    this.retries = retries;
  }

  send(to: string) {
    return this.#formatter.format(to, this.#clock.now());
  }
}

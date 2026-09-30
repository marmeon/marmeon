import { Clock } from '@acme/clock';
import type { Mailer } from './mailer.js';

export class FakeMailer implements Mailer {
  readonly #clock: Clock;
  constructor(clock: Clock) {
    this.#clock = clock;
  }
  send(to: string) {
    return `fake → ${to} at ${this.#clock.now()}`;
  }
}

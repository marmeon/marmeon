// Grüße 🚀 — non-ASCII before the class must not shift the insertion point.
import { Clock, Greeter } from './services.ts';

export class WelcomeController {
  readonly #clock: Clock;
  readonly #greeter: Greeter;

  constructor(clock: Clock, greeter: Greeter) {
    this.#clock = clock;
    this.#greeter = greeter;
  }

  handle() {
    return `${this.#greeter.greet('Ada')} at ${this.#clock.now()}`;
  }

  fail(): never {
    throw new Error('thrown on line 18');
  }
}

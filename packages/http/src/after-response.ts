/**
 * Work for after the response — the client does not wait for it, and its duration tells the client
 * nothing (Laravel's `defer()`). Per request; the server kernel runs the tasks once the response is
 * handed off, and tests wait for them (`kernel.settle()`). Errors are logged, never sent.
 *
 * ```ts
 * this.#afterResponse.defer(() => this.#mailer.send(new WelcomeMail(user)));
 * ```
 *
 * Not a queue: the work dies with the process. Durable background jobs come with queues (wave 6).
 */
export class AfterResponse {
  readonly #tasks: (() => unknown)[] = [];

  defer(task: () => unknown): void {
    this.#tasks.push(task);
  }

  /** @internal — the kernel takes the tasks once the response is out. */
  take(): (() => unknown)[] {
    return this.#tasks.splice(0);
  }
}

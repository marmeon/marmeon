/**
 * Work for after the response — the client does not wait for it, and its duration tells the client
 * nothing (Laravel's `defer()`). Per request; the server kernel runs the tasks once the response is
 * handed off, and tests wait for them (`kernel.settle()`). Errors are logged, never sent.
 *
 * ```ts
 * this.#afterResponse.defer(() => this.#mailer.send(new WelcomeMail(user)));
 * ```
 *
 * Deferred work runs outside of any transaction (E107): registered inside `connections.transaction()`, it does not
 * join it — it runs after the response, on its own. For work that must wait for a commit, use `afterCommit()`.
 *
 * Not a queue: the work dies with the process. Durable background work: `@marmeon/queue`.
 */
export class AfterResponse {
  readonly #tasks: (() => unknown)[] = [];
  #permit: ((what: string) => boolean) | undefined;

  defer(task: () => unknown): void {
    if (this.#permit && !this.#permit('afterResponse.defer()')) return;
    this.#tasks.push(task);
  }

  /** @internal — a read-only request (an island, E52) defers nothing: `permit` throws or drops the task. */
  lock(permit: (what: string) => boolean): void {
    this.#permit = permit;
  }

  /** @internal — the kernel takes the tasks once the response is out. */
  take(): (() => unknown)[] {
    return this.#tasks.splice(0);
  }
}

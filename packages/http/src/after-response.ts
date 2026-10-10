/**
 * Work for after the response: the client does not wait for it, and an error is logged, never sent. Runs outside any open
 * transaction (work that must wait for a commit: `afterCommit()`), and dies with the process — not a queue. See
 * docs/controllers.md#work-after-the-response.
 *
 * ```ts
 * this.#afterResponse.defer(() => this.#mailer.send(new WelcomeMail(user)));
 * ```
 */
export class AfterResponse {
  readonly #tasks: (() => unknown)[] = [];
  #permit: ((what: string) => boolean) | undefined;

  defer(task: () => unknown): void {
    if (this.#permit && !this.#permit('afterResponse.defer()')) return;
    this.#tasks.push(task);
  }

  /** @internal — a read-only request (an island) defers nothing: `permit` throws or drops the task. */
  lock(permit: (what: string) => boolean): void {
    this.#permit = permit;
  }

  /** @internal — the kernel takes the tasks once the response is out. */
  take(): (() => unknown)[] {
    return this.#tasks.splice(0);
  }
}

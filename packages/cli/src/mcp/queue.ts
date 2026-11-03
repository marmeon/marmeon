/**
 * Runs the jobs it is given one after the other: the tools that start a child process wait for each other, so the agent
 * never has two apps booting at once.
 */
export class SerialQueue {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(job: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(job, job);
    this.#tail = result.catch(() => undefined);
    return result;
  }
}

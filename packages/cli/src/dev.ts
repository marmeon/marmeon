/** A process `bespoke dev` runs next to the server, e.g. a queue worker (E101): `bespoke <args>` in the app root. */
export interface DevProcess {
  /** Shown in messages: `queue`. */
  readonly name: string;
  /** The `bespoke` arguments: `['queue:work']`. */
  readonly args: readonly string[];
}

/**
 * What `bespoke dev` starts besides the server — packages add theirs in `boot()` (the queue its worker, the scheduler
 * its `schedule:work`). They start with the server and stop with it, so a code change restarts them too.
 * Never in production: `bespoke start` runs only the server; workers there belong to a supervisor.
 */
export class DevProcesses {
  readonly #processes = new Map<string, DevProcess>();

  add(process: DevProcess): this {
    this.#processes.set(process.name, process);
    return this;
  }

  all(): DevProcess[] {
    return [...this.#processes.values()];
  }
}

import { Clock, currentLogContext } from '@marmeon/core';
import { Database, sql } from '@marmeon/database';

/** Records a run of its task — its name, the minute (by the app's clock) and the process — in the table `ran`. */
export class RecordRun {
  readonly #db: Database;
  readonly #clock: Clock;

  constructor(db: Database, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  async handle(): Promise<void> {
    const minute = Math.floor(this.#clock.now() / 60_000) * 60_000;
    await sql`insert into ran (task, minute, pid) values (${String(currentLogContext().task)}, ${minute}, ${process.pid})`.execute(this.#db);
  }
}

/** A run that never ends and holds no handle: nothing but a timer of the worker keeps its process alive. */
export class HangRun {
  handle(): Promise<void> {
    return new Promise(() => {});
  }
}

import { openTransactionOf, TransactionError } from '@marmeon/core';
import type { DatabaseConnection, Driver, TransactionSettings } from 'kysely';
import type { MarmeonDriver } from './driver.ts';

/** Who uses an infrastructure connection — for the message when it cannot work (see {@link InfrastructureTransactionError}). */
export interface InfrastructureUsage {
  /** Who it is, starting a sentence: `The cache (CACHE_DRIVER=database)`. */
  readonly system: string;
  /** What to do instead, as sentences: `Give the cache its own SQLite file … or use Redis (CACHE_DRIVER=redis).` */
  readonly remedy: string;
}

const UNNAMED: InfrastructureUsage = {
  system: 'An infrastructure connection',
  remedy: 'Give it a connection of its own (another SQLite file, or Postgres).',
};

/**
 * An infrastructure system (the cache, rate limits, locks, sessions) was used inside an open transaction of a connection
 * whose only physical connection that transaction holds — SQLite, or a test's isolated connection (E108). Joining would
 * roll its writes back with the transaction (a rate limit undone, a lock nobody else sees); waiting would never end.
 */
export class InfrastructureTransactionError extends TransactionError {
  override name = 'InfrastructureTransactionError';
  readonly connection: string;

  constructor(connection: string, usage: InfrastructureUsage, isolated: boolean) {
    super(
      `${usage.system} cannot work inside the open transaction on the database connection "${connection}" (E108): ` +
        (isolated
          ? "in a test, the connection is isolated — one physical connection, which that transaction holds — "
          : 'it is a SQLite file, and that transaction holds its only connection — ') +
        'its writes would either join the transaction (and be rolled back with it) or wait for it forever. ' +
        `${usage.remedy} Outside of transactions the shared connection works.`,
    );
    this.connection = connection;
  }
}

/**
 * The driver of an infrastructure connection (E108): every statement runs on a connection of its own, never inside the
 * app's ambient transaction — a rate-limit counter or a lock taken inside a transaction that rolls back stays, and other
 * processes see a lock at once.
 *
 * - **Postgres:** a small pool of its own (`infrastructurePoolMax`) to the same database, opened on first use — also so
 *   that transactions waiting for a rate limit can never use up the pool the rate limit needs.
 * - **SQLite, and a test's isolated connection:** one physical connection for everyone, shared with the connection's
 *   other users. Outside of transactions that is all it takes; inside an open transaction of the same file — which holds
 *   that connection — every statement throws {@link InfrastructureTransactionError} instead of joining or hanging.
 *
 * It runs single statements only: no transactions of its own.
 */
export class InfrastructureDriver implements Driver {
  readonly #main: MarmeonDriver;
  /** Every driver of the same physical database (the SQLite file) — a transaction of any of them holds it. */
  readonly #peers: () => readonly MarmeonDriver[];
  /** Postgres: the pool of its own, created on first use. */
  readonly #pool: (() => MarmeonDriver) | undefined;
  readonly #usage: InfrastructureUsage;
  /** Connections handed out from the pool of its own (the others go back to the main driver). */
  readonly #own = new WeakSet<DatabaseConnection>();

  constructor(options: {
    main: MarmeonDriver;
    peers: () => readonly MarmeonDriver[];
    pool?: () => MarmeonDriver;
    usage?: InfrastructureUsage;
  }) {
    this.#main = options.main;
    this.#peers = options.peers;
    this.#pool = options.pool;
    this.#usage = options.usage ?? UNNAMED;
  }

  async init(): Promise<void> {
    // The pool of its own connects on first use (acquireConnection); the shared one may be needed now.
    if (!this.#pool) await this.#main.init();
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    if (this.#pool && !this.#main.sharesOneConnection) {
      const pool = this.#pool();
      await pool.init();
      const connection = await pool.acquireConnection();
      this.#own.add(connection);
      return connection;
    }
    // One physical connection for everyone: never while a transaction of this call chain holds it.
    for (const driver of this.#peers()) {
      // (A Postgres connection that shares one physical connection is a test's isolated one.)
      if (openTransactionOf(driver)) throw new InfrastructureTransactionError(driver.name, this.#usage, this.#pool !== undefined);
    }
    await this.#main.init();
    return this.#main.acquireDetached();
  }

  async releaseConnection(connection: DatabaseConnection): Promise<void> {
    if (this.#own.has(connection)) {
      this.#own.delete(connection);
      await this.#pool!().releaseConnection(connection);
      return;
    }
    await this.#main.releaseConnection(connection);
  }

  beginTransaction(_connection: DatabaseConnection, _settings: TransactionSettings): Promise<void> {
    return Promise.reject(this.#noTransactions());
  }

  commitTransaction(): Promise<void> {
    return Promise.reject(this.#noTransactions());
  }

  rollbackTransaction(): Promise<void> {
    return Promise.reject(this.#noTransactions());
  }

  /** The pools belong to `Connections`, which closes them. */
  async destroy(): Promise<void> {}

  #noTransactions(): TransactionError {
    return new TransactionError(
      `${this.#usage.system} runs single statements on its own connection (E108) — it has no transactions. Make each operation one statement.`,
    );
  }
}

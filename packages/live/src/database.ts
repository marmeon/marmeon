import { SystemClock, type Clock, type Logger, type Redactor } from '@marmeon/core';
import type { Connection } from '@marmeon/database';
import { messageText, type LiveBackend, type LiveMessage } from './backend.ts';

/** The table `marmeon make:live-table` creates (the app owns the migration; the backend types it itself). */
export const LIVE_HINTS_TABLE = 'live_hints';
/** The columns the backend reads and writes; readiness is red while the table lacks one. */
export const LIVE_HINTS_COLUMNS = ['id', 'channel', 'message', 'created_at'];

/** A connection of @marmeon/database and its driver. */
export interface DatabaseLiveConnection {
  readonly db: Connection<any>;
  readonly driver: 'sqlite' | 'pgsql';
}

/** What the backend needs besides its connection. */
export interface DatabaseLiveOptions {
  /** How often the poller looks for rows of other processes, in ms. */
  readonly pollMs: number;
  readonly logger: Logger;
  readonly redactor: Redactor;
  readonly clock?: Clock | undefined;
}

type Sql = (typeof import('@marmeon/database'))['sql'];

/**
 * Hints in the app's database (`LIVE_DRIVER=database`): a row per hint, or per session that ended, in `live_hints`. A row
 * never carries data — the channel, the names of the props to reload, the scope of a session that ended. The `id` is the one
 * sequence of all processes: a channel's number is the id of its last row (so it rises, with gaps, across channels). Rows are
 * written on the infrastructure connection, which never joins the app's transaction. See `docs/realtime.md#more-than-one-process`.
 */
export class DatabaseLiveBackend implements LiveBackend {
  readonly #connection: () => Promise<DatabaseLiveConnection>;
  readonly #options: DatabaseLiveOptions;
  readonly #clock: Clock;
  readonly #listeners = new Set<(message: LiveMessage) => void>();
  #sql: Promise<Sql> | undefined;

  /** `connection`: resolved on first use — the backend is built before the database package's provider boots. */
  constructor(connection: () => Promise<DatabaseLiveConnection>, options: DatabaseLiveOptions) {
    this.#connection = connection;
    this.#options = options;
    this.#clock = options.clock ?? new SystemClock();
  }

  async refresh(channel: string, only: readonly string[] | null, except: string | undefined): Promise<number> {
    return this.#insert(channel, messageText({ kind: 'refresh', channel, only, except }));
  }

  async end(scope: string): Promise<void> {
    await this.#insert(null, messageText({ kind: 'end', scope }));
  }

  async seqs(channels: readonly string[]): Promise<number[]> {
    if (channels.length === 0) return [];
    const { db, sql } = await this.#use();
    const { rows } = await sql<{ channel: string; seq: number | string }>`select channel, max(id) as seq from live_hints where channel in (${sql.join(channels)}) group by channel`.execute(db);
    const seqs = new Map(rows.map((row) => [row.channel, Number(row.seq)]));
    return channels.map((channel) => seqs.get(channel) ?? 0);
  }

  async listen(listener: (message: LiveMessage) => void): Promise<() => Promise<void>> {
    this.#listeners.add(listener);
    return async () => void this.#listeners.delete(listener);
  }

  async close(): Promise<void> {
    this.#listeners.clear();
  }

  async #insert(channel: string | null, message: string): Promise<number> {
    const { db, sql } = await this.#use();
    const { rows } = await sql<{ id: number | string }>`insert into live_hints (channel, message, created_at) values (${channel}, ${message}, ${this.#clock.now()}) returning id`.execute(db);
    return Number(rows[0]!.id);
  }

  async #use(): Promise<DatabaseLiveConnection & { sql: Sql }> {
    // Imported here, not at the top: @marmeon/database is an optional peer of live.
    this.#sql ??= import('@marmeon/database').then((module) => module.sql);
    const [connection, sql] = await Promise.all([this.#connection(), this.#sql]);
    return { ...connection, sql };
  }
}

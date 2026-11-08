import { AsyncLocalStorage } from 'node:async_hooks';
import { SystemClock, type Clock, type Logger, type Redactor } from '@marmeon/core';
import type { Connection } from '@marmeon/database';
import { messageText, parseMessage, type LiveBackend, type LiveMessage } from './backend.ts';

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

/** Rows one poll reads at most; a full batch is followed by the next poll at once. */
const BATCH = 1000;
/** Ids a poll waits for at most (a larger gap is not waited for), and how long it waits for one. */
const MAX_PENDING = 1000;
const PENDING_MS = 10_000;
/** Rows this process has delivered, by id — at most this many are remembered (the oldest go first). */
const MAX_DELIVERED = 10_000;
/** Logs about a poll that fails, or about rows that are no messages, come at most this often (ms). */
const LOG_EVERY_MS = 60_000;

/** The context of the boot, outside any request: the poll loop starts in it, so its queries never become spans of the first request that listened. */
const atBoot = AsyncLocalStorage.snapshot();

interface Row {
  readonly id: number | string;
  readonly channel: string | null;
  readonly message: string;
}

type Sql = (typeof import('@marmeon/database'))['sql'];

/**
 * Hints in the app's database (`LIVE_DRIVER=database`): a row per hint, or per session that ended, in `live_hints`. A row
 * never carries data — the channel, the names of the props to reload, the scope of a session that ended. The `id` is the one
 * sequence of all processes: a channel's number is the id of its last row (so it rises, with gaps, across channels). Rows are
 * written on the infrastructure connection, which never joins the app's transaction.
 *
 * One loop per process polls the table (`pollMs`) and delivers every row in id order; a hint sent by this process reaches its
 * own listeners at once and is skipped when the loop meets it. Ids can become visible out of order (Postgres commits): the
 * loop remembers the ids it jumped over and asks for them again until they appear or ten seconds passed. See `docs/realtime.md#more-than-one-process`.
 */
export class DatabaseLiveBackend implements LiveBackend {
  readonly #connection: () => Promise<DatabaseLiveConnection>;
  readonly #options: DatabaseLiveOptions;
  readonly #clock: Clock;
  readonly #listeners = new Set<(message: LiveMessage) => void>();
  #sql: Promise<Sql> | undefined;
  /** The highest id delivered (or skipped); undefined while the loop does not run. */
  #cursor: number | undefined;
  #start: Promise<void> | undefined;
  #timer: NodeJS.Timeout | undefined;
  #round: Promise<void> | undefined;
  #stopped = false;
  /**
   * The rows this process delivered, id → channel (null: an end). The poller and a sender both claim an id here, in the step
   * that calls the listeners: whichever comes first delivers, the other skips — a row is never heard twice.
   */
  readonly #delivered = new Map<number, string | null>();
  /** Ids the loop jumped over → when it noticed. */
  readonly #pending = new Map<number, number>();
  /** Whether the streak of failures going on was logged (its recovery is announced only then). */
  #streakLogged: boolean | undefined;
  #lastFailureLog = Number.NEGATIVE_INFINITY;
  #lastInvalidLog = Number.NEGATIVE_INFINITY;

  /** `connection`: resolved on first use — the backend is built before the database package's provider boots. */
  constructor(connection: () => Promise<DatabaseLiveConnection>, options: DatabaseLiveOptions) {
    this.#connection = connection;
    this.#options = options;
    this.#clock = options.clock ?? new SystemClock();
  }

  async refresh(channel: string, only: readonly string[] | null, except: string | undefined): Promise<number> {
    const id = await this.#insert(channel, messageText({ kind: 'refresh', channel, only, except }));
    this.#deliverNow(id, channel, { kind: 'refresh', channel, only, seq: id, ...(except === undefined ? {} : { except }) });
    return id;
  }

  async end(scope: string): Promise<void> {
    const id = await this.#insert(null, messageText({ kind: 'end', scope }));
    this.#deliverNow(id, null, { kind: 'end', scope });
  }

  /** The newest row of each channel this process has delivered — what `hello` says is what the streams here were told. */
  async seqs(channels: readonly string[]): Promise<number[]> {
    if (channels.length === 0) return [];
    const { db, sql } = await this.#use();
    const cursor = this.#cursor;
    const { rows } = await sql<{ channel: string; seq: number | string }>`select channel, max(id) as seq from live_hints where channel in (${sql.join(channels)})
      ${cursor === undefined ? sql`` : sql`and id <= ${cursor}`} group by channel`.execute(db);
    const seqs = new Map(rows.map((row) => [row.channel, Number(row.seq)]));
    for (const [id, channel] of this.#delivered) if (channel !== null && id > (seqs.get(channel) ?? 0)) seqs.set(channel, id);
    return channels.map((channel) => seqs.get(channel) ?? 0);
  }

  async listen(listener: (message: LiveMessage) => void): Promise<() => Promise<void>> {
    this.#listeners.add(listener);
    this.#stopped = false;
    this.#start ??= atBoot(() => this.#begin()).catch((error: unknown) => {
      this.#start = undefined;
      throw error;
    });
    try {
      await this.#start;
    } catch (error) {
      this.#listeners.delete(listener);
      throw error;
    }
    return async () => void this.#listeners.delete(listener);
  }

  async close(): Promise<void> {
    this.#stopped = true;
    this.#listeners.clear();
    clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#start?.catch(() => undefined);
    await this.#round;
    this.#start = undefined;
    this.#cursor = undefined;
    this.#delivered.clear();
    this.#pending.clear();
  }

  /** Reads where the table stands (rows from before are not delivered) and starts the loop. */
  async #begin(): Promise<void> {
    const { db, sql } = await this.#use();
    const { rows } = await sql<{ id: number | string | null }>`select max(id) as id from live_hints`.execute(db);
    this.#cursor = Number(rows[0]?.id ?? 0);
    this.#schedule(this.#options.pollMs);
  }

  #schedule(delay: number): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#round = this.#poll().finally(() => (this.#round = undefined));
    }, delay);
    this.#timer.unref();
  }

  async #poll(): Promise<void> {
    let full = false;
    try {
      full = await this.#read();
      if (this.#streakLogged) this.#options.logger.info('Polling the live_hints table works again');
      this.#streakLogged = undefined;
    } catch (error) {
      const now = this.#clock.now();
      this.#streakLogged ??= false;
      if (now - this.#lastFailureLog >= LOG_EVERY_MS) {
        this.#lastFailureLog = now;
        this.#streakLogged = true;
        this.#options.logger.error('Polling the live_hints table failed; hints of other processes wait until it works again', { exception: this.#options.redactor.text(String(error)) });
      }
    }
    this.#schedule(full ? 0 : this.#options.pollMs);
  }

  /** One round: what is new, and the ids that were skipped over earlier. Returns whether the batch was full. */
  async #read(): Promise<boolean> {
    const { db, sql } = await this.#use();
    const cursor = this.#cursor!;
    const { rows } = await sql<Row>`select id, channel, message from live_hints where id > ${cursor} order by id limit ${BATCH}`.execute(db);
    const late =
      this.#pending.size === 0 ? [] : (await sql<Row>`select id, channel, message from live_hints where id in (${sql.join([...this.#pending.keys()])}) order by id`.execute(db)).rows;
    if (this.#stopped) return false;
    const now = this.#clock.now();
    for (const row of late) {
      this.#pending.delete(Number(row.id));
      this.#deliverRow(row);
    }
    let expected = cursor + 1;
    for (const row of rows) {
      const id = Number(row.id);
      for (let missing = expected; missing < id; missing++) {
        if (this.#pending.size >= MAX_PENDING) {
          this.#options.logger.debug('A gap in the live_hints ids is too large to wait for', { from: missing, to: id - 1 });
          break;
        }
        this.#pending.set(missing, now);
      }
      expected = id + 1;
      this.#deliverRow(row);
      this.#cursor = id;
    }
    for (const [id, since] of this.#pending) if (now - since >= PENDING_MS) this.#pending.delete(id);
    return rows.length === BATCH;
  }

  #deliverRow(row: Row): void {
    const id = Number(row.id);
    if (this.#delivered.has(id)) return;
    const message = parseMessage(`${row.message.slice(0, -1)},"seq":${id}}`);
    if (!message) {
      const now = this.#clock.now();
      if (now - this.#lastInvalidLog >= LOG_EVERY_MS) {
        this.#lastInvalidLog = now;
        this.#options.logger.warn('A row of the live_hints table is no live message; ignored', { id });
      }
      return;
    }
    this.#claim(id, row.channel);
    this.#send(message);
  }

  /** Remembers that the row is delivered (in the same step as the delivery, so the two paths cannot both send it). */
  #claim(id: number, channel: string | null): void {
    this.#delivered.set(id, channel);
    if (this.#delivered.size > MAX_DELIVERED) this.#delivered.delete(this.#delivered.keys().next().value!);
  }

  /** The listeners of this process hear what it sent at once; the loop skips the row when it reads it. */
  #deliverNow(id: number, channel: string | null, message: LiveMessage): void {
    if (this.#listeners.size === 0 || this.#delivered.has(id)) return;
    this.#claim(id, channel);
    this.#send(message);
  }

  #send(message: LiveMessage): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(message);
      } catch (error) {
        this.#options.logger.error('A listener of the live backend failed', { exception: this.#options.redactor.text(String(error)) });
      }
    }
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

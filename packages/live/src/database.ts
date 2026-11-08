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
/** Channels whose newest delivered id is remembered for `seqs()` — the least recently hinted go first. */
const MAX_CHANNELS = 10_000;
/** How long the end rows, and the refresh rows a newer one of their channel replaced, are kept (ms): far beyond the poll interval and the wait for a late id. */
const SUPERSEDED_MS = 5 * 60_000;
/** How long any row is kept (ms) — as Redis keeps a channel's sequence. */
const KEEP_MS = 86_400_000;
/** Rows one rule of a prune deletes at most. */
const PRUNE_BATCH = 1000;
/** A process prunes about this often (ms), give or take a fifth. */
const PRUNE_EVERY_MS = 60_000;
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
  /** Channel → the highest id of it this process delivered (what `seqs()` adds to the table), least recently hinted first. */
  readonly #channelSeqs = new Map<string, number>();
  /** When the loop prunes next (epoch ms by the clock). */
  #nextPrune = 0;
  /** Ids the loop jumped over → when it noticed. */
  readonly #pending = new Map<number, number>();
  /** Whether the streak of failed polls going on was logged (its recovery is announced only then). */
  #streakLogged: boolean | undefined;
  /** When the streak of failed polls began (by the clock). */
  #failingSince: number | undefined;
  /** Whether the log line about an unreadable id counter was written (once per process). */
  #blindLogged = false;
  /** The next refreshes tell every prop to reload: rows may have gone unseen whose `only` they would have added to. */
  #widen = false;
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
    return channels.map((channel) => Math.max(seqs.get(channel) ?? 0, this.#channelSeqs.get(channel) ?? 0));
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
    this.#forgetDelivered();
    this.#nextPrune = 0;
  }

  /**
   * Deletes the rows nobody needs any more: end rows and refresh rows replaced by a newer one of their channel, once they are five
   * minutes old, and everything older than a day — each rule at most 1000 rows at a time. Returns how many it removed. Ids are never
   * reused, so a poller never takes a new row for one it has read. Every polling process runs it about once a minute.
   */
  async prune(): Promise<number> {
    const { db, sql } = await this.#use();
    const now = this.#clock.now();
    const affected = async (statement: { execute: (db: Connection<any>) => Promise<{ numAffectedRows?: bigint | undefined }> }) => Number((await statement.execute(db)).numAffectedRows ?? 0n);
    const recent = now - SUPERSEDED_MS;
    let removed = await affected(sql`delete from live_hints where id in (select id from live_hints where channel is null and created_at < ${recent} limit ${PRUNE_BATCH})`);
    removed += await affected(sql`delete from live_hints where id in (select h.id from live_hints h where h.channel is not null and h.created_at < ${recent}
      and exists (select 1 from live_hints n where n.channel = h.channel and n.id > h.id) limit ${PRUNE_BATCH})`);
    removed += await affected(sql`delete from live_hints where id in (select id from live_hints where created_at < ${now - KEEP_MS} limit ${PRUNE_BATCH})`);
    return removed;
  }

  #forgetDelivered(): void {
    this.#delivered.clear();
    this.#channelSeqs.clear();
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
      this.#failingSince = undefined;
    } catch (error) {
      this.#failingSince ??= this.#clock.now();
      this.#streakLogged = this.#failed(error, 'Polling the live_hints table failed; hints of other processes wait until it works again') || (this.#streakLogged ?? false);
    }
    if (!this.#stopped && this.#clock.now() >= this.#nextPrune) {
      this.#nextPrune = this.#clock.now() + PRUNE_EVERY_MS * (0.8 + Math.random() * 0.4);
      try {
        await this.prune();
      } catch (error) {
        this.#failed(error, 'Pruning the live_hints table failed');
      }
    }
    this.#schedule(full ? 0 : this.#options.pollMs);
  }

  /** Logs a failure of the loop — at most once a minute, whatever the streak. Returns whether it logged. */
  #failed(error: unknown, message: string): boolean {
    const now = this.#clock.now();
    if (now - this.#lastFailureLog < LOG_EVERY_MS) return false;
    this.#lastFailureLog = now;
    this.#options.logger.error(message, { exception: this.#options.redactor.text(String(error)) });
    return true;
  }

  /**
   * Whether the table started again (dropped and created anew, as `migrate:fresh` does): the counter of its ids only goes
   * down then. Rows of the new table have ids below the cursor, so a round that finds nothing asks. Fails closed: a counter this
   * role cannot read (or that does not exist) means "not restarted" — such a table is noticed only once its first row raises the counter.
   */
  async #restarted(): Promise<boolean> {
    const { db, sql, driver } = await this.#use();
    // SQLite has the counter table only once some table counts with AUTOINCREMENT.
    const counted = driver !== 'sqlite' || (await sql`select 1 as found from sqlite_master where name = 'sqlite_sequence'`.execute(db)).rows.length > 0;
    const { rows } = !counted
      ? { rows: [] as { seq: null }[] }
      : driver === 'sqlite'
        ? await sql<{ seq: number | string | null }>`select seq from sqlite_sequence where name = 'live_hints'`.execute(db)
        : await sql<{ seq: number | string | null }>`select case when has_sequence_privilege(s, 'SELECT') then pg_sequence_last_value(s) end as seq
            from (select pg_get_serial_sequence('live_hints', 'id')::regclass as s) as counter`.execute(db);
    const last = rows[0]?.seq;
    if (last === null || last === undefined) {
      if (this.#cursor! > 0 && !this.#blindLogged) {
        // Only a table with rows has a counter that should be readable: an empty one (just created) is not worth a line.
        const newest = (await sql<{ id: number | string | null }>`select max(id) as id from live_hints`.execute(db)).rows[0]?.id;
        if (newest !== null && newest !== undefined) {
          this.#blindLogged = true;
          this.#options.logger.info('The id counter of the live_hints table cannot be read; until it can, a recreated table is not noticed');
        }
      }
      return false;
    }
    return Number(last) < this.#cursor!;
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
    if (rows.length === 0 && late.length === 0 && (await this.#restarted())) {
      this.#cursor = 0;
      this.#forgetDelivered();
      this.#options.logger.info('The live_hints table started again; polling it from its first row');
      return true;
    }
    // After polls failed for longer than rows are kept, the surviving newest row of a channel may name fewer props than the ones pruned.
    const widen = this.#widen || (this.#failingSince !== undefined && now - this.#failingSince >= SUPERSEDED_MS);
    let unseen = false;
    let sent = false;
    for (const row of late) {
      this.#pending.delete(Number(row.id));
      sent = this.#deliverRow(row, widen) || sent;
    }
    let expected = cursor + 1;
    for (const row of rows) {
      const id = Number(row.id);
      for (let missing = expected; missing < id; missing++) {
        if (this.#pending.size >= MAX_PENDING) {
          this.#options.logger.debug('A gap in the live_hints ids is too large to wait for', { from: missing, to: id - 1 });
          unseen = true;
          break;
        }
        this.#pending.set(missing, now);
      }
      expected = id + 1;
      sent = this.#deliverRow(row, widen) || sent;
      this.#cursor = id;
    }
    for (const [id, since] of this.#pending) {
      if (now - since < PENDING_MS) continue;
      this.#pending.delete(id);
      unseen = true;
    }
    // Best effort: an id that never showed up (or was too far off to wait for) was often a rolled-back insert, but may have been a hint, so
    // the next refresh reloads every prop. After an outage this holds while the backlog still comes in full batches.
    this.#widen = unseen || (widen && (!sent || rows.length === BATCH));
    return rows.length === BATCH;
  }

  /** Whether it sent a refresh. */
  #deliverRow(row: Row, widen: boolean): boolean {
    const id = Number(row.id);
    if (this.#delivered.has(id)) return false;
    const message = parseMessage(`${row.message.slice(0, -1)},"seq":${id}}`);
    if (!message) {
      const now = this.#clock.now();
      if (now - this.#lastInvalidLog >= LOG_EVERY_MS) {
        this.#lastInvalidLog = now;
        this.#options.logger.warn('A row of the live_hints table is no live message; ignored', { id });
      }
      return false;
    }
    this.#claim(id, row.channel);
    this.#send(widen && message.kind === 'refresh' ? { ...message, only: null } : message);
    return message.kind === 'refresh';
  }

  /** Remembers that the row is delivered (in the same step as the delivery, so the two paths cannot both send it). */
  #claim(id: number, channel: string | null): void {
    this.#delivered.set(id, channel);
    if (this.#delivered.size > MAX_DELIVERED) this.#delivered.delete(this.#delivered.keys().next().value!);
    if (channel !== null && id > (this.#channelSeqs.get(channel) ?? 0)) {
      // Last hinted now: to the end of the map.
      this.#channelSeqs.delete(channel);
      this.#channelSeqs.set(channel, id);
      if (this.#channelSeqs.size > MAX_CHANNELS) this.#channelSeqs.delete(this.#channelSeqs.keys().next().value!);
    }
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

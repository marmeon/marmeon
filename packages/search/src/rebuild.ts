import { createHash, randomUUID } from 'node:crypto';
import type { Clock, Resolver } from '@marmeon/core';
import { Database, sql, type Connections } from '@marmeon/database';
import { searchOptions } from './config.ts';
import type { SearchDriver, SearchKey } from './driver.ts';
import { DatabaseSearchDriver } from './drivers/database/index.ts';
import type { IndexInfo, SearchIndexes } from './registry.ts';
import { BATCH_SIZE, checkKey, keyId, write, type IndexReader, type ReadResult } from './search.ts';
import type { SearchIndex, SearchIndexClass } from './search-index.ts';
import { MAX_WRITES, sameRead } from './sync-job.ts';

/** How long a lock holds without a heartbeat: a run that stopped without releasing it frees the index after this. */
export const LOCK_MILLISECONDS = 60_000;
/** The largest batch: a driver gets at most 500 documents per write. */
export const MAX_REBUILD_BATCH = BATCH_SIZE;

/** The state of an unfinished rebuild of one index, as `search_rebuilds` keeps it. */
interface RebuildRow {
  readonly run: string;
  /** `copy`: rows are copied, from the key in `after` on. `sweep`: the copy is done; the database driver sweeps from the id in `after`, a driver with `swap()` has started its swap. */
  readonly phase: 'copy' | 'sweep';
  readonly after: string | null;
  readonly target: string | null;
  readonly started: string;
  readonly fingerprint: string | null;
}

/** What one rebuild did: it finished, another run holds the lock, or this run lost it to another one. */
export type RebuildOutcome =
  | { readonly status: 'done'; readonly indexed: number; readonly removed: number }
  | { readonly status: 'held'; readonly until: string }
  | { readonly status: 'lost' };

/** How one rebuild runs: documents per batch, whether an unfinished run is discarded, and where its lines go. */
export interface RebuildOptions {
  readonly batch: number;
  readonly fresh: boolean;
  readonly report: (line: string) => void;
}

/** @internal Points the package's own tests stop or change a run at; nothing else sets them. */
export interface RebuildHooks {
  /** After each batch is written and its checkpoint saved. */
  readonly afterBatch?: (phase: 'copy' | 'sweep') => void | Promise<void>;
  /** In a batch of the sweep, after it read the documents and their rows, before it removes any. */
  readonly beforeSweepDelete?: () => void | Promise<void>;
}

/** @internal What a `Rebuilder` is built from; the provider hands these over. */
export interface RebuilderParts {
  readonly indexes: SearchIndexes;
  readonly reader: IndexReader;
  readonly driver: () => SearchDriver;
  readonly connections: () => Connections;
  readonly container: Resolver;
  readonly clock: Clock;
  readonly hooks?: RebuildHooks | undefined;
}

/** Thrown inside a run when its heartbeat finds another holder: the batch's transaction rolls back, and the run stops. */
class LockLost extends Error {
  override name = 'LockLost';
}

/** A timestamp as the database returned it, as ISO text: Postgres drivers may hand out a `Date`. */
function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/** The time a run took, for its last line. */
function duration(milliseconds: number): string {
  return milliseconds < 1000 ? `${milliseconds} ms` : `${(milliseconds / 1000).toFixed(1)} s`;
}

/**
 * The target a running rebuild of an index fills, from `search_rebuilds`, or `undefined` when none does. Read by the job
 * `marmeon.search.sync` of a driver with `swap()`, which writes to the target too.
 */
export async function rebuildTarget(connections: Connections, index: string): Promise<string | undefined> {
  const { rows } = await sql<{ target: string | null }>`select target from search_rebuilds where index_name = ${index}`.execute(connections.get('default'));
  return rows[0]?.target ?? undefined;
}

/**
 * Rebuilds an index from its rows: keyset batches over `source()`, each written and checkpointed in `search_rebuilds`, under a lock that
 * one run holds at a time. The `database` driver then sweeps the documents whose rows are gone; a driver with `swap()` fills a target
 * of its own and swaps it in. An unfinished run resumes from its checkpoint. See `docs/full-text-search.md#rebuilding-and-flushing`.
 * @internal
 */
export class Rebuilder {
  readonly #parts: RebuilderParts;

  constructor(parts: RebuilderParts) {
    this.#parts = parts;
  }

  get #db() {
    return this.#parts.connections().get('default');
  }

  async rebuild(Index: SearchIndexClass, options: RebuildOptions): Promise<RebuildOutcome> {
    const info = this.#parts.indexes.info(Index);
    const { name } = info;
    const driver = this.#parts.driver();
    const started = this.#parts.clock.now();
    await this.#requireTable();
    const fingerprint = this.#fingerprint(info);
    const me = randomUUID();
    const claim = await this.#claim(name, me, fingerprint);
    if (claim.held !== undefined) return { status: 'held', until: claim.held };
    let row = claim.row;
    try {
      if (!claim.created) {
        // A swap that started may have happened: swapping again would put the old documents live, so that run cannot go on.
        const swapStarted = driver.swap !== undefined && row.phase === 'sweep';
        // The batches of a run under another definition or language map hold documents of the old one.
        const changed = row.fingerprint !== fingerprint;
        if (options.fresh || swapStarted || changed) {
          options.report(
            swapStarted
              ? `${name}: the unfinished run stopped during its swap and cannot go on; starting a new run.`
              : changed && !options.fresh
                ? `${name}: the index definition or the language map changed since the unfinished run started at ${row.started}; starting a new run.`
                : `${name}: --fresh discards the unfinished run started at ${row.started}.`,
          );
          const leftover = row.target === null ? undefined : await this.#discard(driver, info, row.target);
          if (leftover !== undefined) options.report(leftover);
          row = await this.#restart(name, me, fingerprint);
        } else {
          options.report(`${name}: resuming the unfinished run started at ${row.started}. It keeps the batches it wrote; after a change to the code of the index class, or to rows behind the back of search, run it with --fresh.`);
        }
      }

      let target: string | undefined;
      if (driver.swap !== undefined) {
        // A resumed run keeps its target; prepare() runs again without harm.
        target = row.target ?? `${name}__rebuild_${row.run.slice(0, 8)}`;
        // The index itself must exist too: a swap needs both, and a job that cannot write to it never reaches the target either,
        // so on a first rebuild every change made while it runs would be lost.
        await driver.prepare?.(info);
        await driver.prepare?.(info, target);
        if (row.target === null) await this.#beat(name, me, { target });
      } else {
        await driver.prepare?.(info);
      }
      const into: IndexInfo = target === undefined ? info : { ...info, name: target };
      const counts = { indexed: 0, removed: 0 };

      if (row.phase === 'copy') await this.#copy(Index, info, into, driver, me, row, options, counts);
      if (target !== undefined) {
        // Saved before the swap: a run that stops from here on starts over rather than swap twice.
        await this.#beat(name, me, { phase: 'sweep', after: null });
        await driver.swap!(info, target);
      } else if (driver instanceof DatabaseSearchDriver) {
        const after = row.phase === 'sweep' && row.after !== null ? Number(row.after) : 0;
        await this.#sweep(Index, info, driver, me, after, options, counts);
      }
      await sql`delete from search_rebuilds where index_name = ${name} and holder = ${me}`.execute(this.#db);
      options.report(`${name}: done in ${duration(this.#parts.clock.now() - started)}, ${counts.indexed} indexed, ${counts.removed} removed.`);
      return { status: 'done', ...counts };
    } catch (error) {
      if (error instanceof LockLost) return { status: 'lost' };
      // Released so that a resume need not wait for the lock to run out. A release that fails too leaves the lock to expire; the
      // error of the run is the one that matters.
      await sql`update search_rebuilds set holder = null, held_until = null where index_name = ${name} and holder = ${me}`.execute(this.#db).catch(() => undefined);
      throw error;
    }
  }

  /** Refuses with the commands that make it when the database has no table `search_rebuilds`. */
  async #requireTable(): Promise<void> {
    if (!(await this.#hasTable())) {
      throw new Error('A rebuild keeps its lock and checkpoint in the table search_rebuilds, which the database does not have yet. Run pnpm marmeon publish @marmeon/search, then pnpm marmeon migrate.');
    }
  }

  /** Whether the database has the table `search_rebuilds`. */
  async #hasTable(): Promise<boolean> {
    const connections = this.#parts.connections();
    const driver = connections.options('default').driver as string;
    const db = this.#db;
    const query =
      driver === 'pgsql'
        ? sql<{ present: unknown }>`select 1 as present where to_regclass('search_rebuilds') is not null`
        : driver === 'mysql'
          ? sql<{ present: unknown }>`select 1 as present from information_schema.tables where table_schema = database() and table_name = 'search_rebuilds'`
          : sql<{ present: unknown }>`select 1 as present from sqlite_master where type = 'table' and name = 'search_rebuilds'`;
    const { rows } = await query.execute(db);
    return rows.length > 0;
  }

  /**
   * Takes the lock of an index: a first run inserts the row, a later one takes it over when no run holds it or its lock ran out.
   * Only exactly one changed row counts as taken.
   */
  async #claim(name: string, me: string, fingerprint: string): Promise<{ readonly created: boolean; readonly row: RebuildRow; readonly held?: undefined } | { readonly held: string }> {
    const now = this.#parts.clock.now();
    const until = now + LOCK_MILLISECONDS;
    const run = randomUUID();
    const startedAt = new Date(now).toISOString();
    const inserted = await sql`insert into search_rebuilds (index_name, run, phase, after, target, holder, held_until, started_at, fingerprint)
      values (${name}, ${run}, 'copy', null, null, ${me}, ${until}, ${startedAt}, ${fingerprint}) on conflict (index_name) do nothing`.execute(this.#db);
    if (Number(inserted.numAffectedRows ?? 0n) === 1) return { created: true, row: { run, phase: 'copy', after: null, target: null, started: startedAt, fingerprint } };
    const taken = await this.#take(name, me);
    const found = await this.#row(name);
    if (!taken || found === undefined) return { held: new Date(Number(found?.held_until ?? until)).toISOString() };
    return { created: false, row: found };
  }

  /** Takes over the lock of an existing row when no run holds it or its lock ran out; whether exactly one row changed. */
  async #take(name: string, me: string): Promise<boolean> {
    const now = this.#parts.clock.now();
    const taken = await sql`update search_rebuilds set holder = ${me}, held_until = ${now + LOCK_MILLISECONDS}
      where index_name = ${name} and (holder is null or held_until is null or held_until < ${now})`.execute(this.#db);
    return Number(taken.numAffectedRows ?? 0n) === 1;
  }

  /** The row of an index, if one. */
  async #row(name: string): Promise<(RebuildRow & { readonly held_until: string | number | null }) | undefined> {
    const { rows } = await sql<{ run: string; phase: 'copy' | 'sweep'; after: string | null; target: string | null; started_at: unknown; held_until: string | number | null; fingerprint: string | null }>`select run, phase, after, target, started_at, held_until, fingerprint
      from search_rebuilds where index_name = ${name}`.execute(this.#db);
    const found = rows[0];
    if (found === undefined) return undefined;
    return { run: String(found.run), phase: found.phase, after: found.after, target: found.target, started: iso(found.started_at), fingerprint: found.fingerprint, held_until: found.held_until };
  }

  /** SHA-256 of the index definition and the language map as canonical JSON: what the documents of a run were written with. */
  #fingerprint(info: IndexInfo): string {
    const languages = [...searchOptions(this.#parts.container).languages].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const definition = [info.name, info.key, info.fields.map((field) => [field.name, field.weight]), info.filters, languages];
    return createHash('sha256').update(JSON.stringify(definition), 'utf8').digest('hex');
  }

  /**
   * Flushes an index under its rebuild lock, so that no rebuild runs while it empties the index and no resume swaps flushed documents
   * back: takes the lock (a row of its own when there is none), deletes or empties the target of an unfinished run, flushes and
   * removes the row. Another run that holds the lock is `held`, and nothing is flushed; an app without the table has no rebuild.
   * @internal
   */
  async flush(info: IndexInfo): Promise<{ readonly status: 'done'; readonly leftover?: string | undefined } | { readonly status: 'held'; readonly until: string }> {
    const driver = this.#parts.driver();
    if (!(await this.#hasTable())) {
      await driver.flush(info);
      return { status: 'done' };
    }
    const me = randomUUID();
    const claim = await this.#claim(info.name, me, this.#fingerprint(info));
    if (claim.held !== undefined) return { status: 'held', until: claim.held };
    let leftover: string | undefined;
    try {
      if (claim.row.target !== null) leftover = await this.#discard(driver, info, claim.row.target);
      await driver.flush(info);
      await sql`delete from search_rebuilds where index_name = ${info.name} and holder = ${me}`.execute(this.#db);
    } catch (error) {
      await sql`update search_rebuilds set holder = null, held_until = null where index_name = ${info.name} and holder = ${me}`.execute(this.#db).catch(() => undefined);
      throw error;
    }
    return { status: 'done', leftover };
  }

  /** Starts a new run in the row this run holds: a new run id, the copy from the first key, no target. */
  async #restart(name: string, me: string, fingerprint: string): Promise<RebuildRow> {
    const run = randomUUID();
    const started = new Date(this.#parts.clock.now()).toISOString();
    const result = await sql`update search_rebuilds set run = ${run}, phase = 'copy', after = null, target = null, started_at = ${started}, fingerprint = ${fingerprint}
      where index_name = ${name} and holder = ${me}`.execute(this.#db);
    if (Number(result.numAffectedRows ?? 0n) !== 1) throw new LockLost();
    return { run, phase: 'copy', after: null, target: null, started, fingerprint };
  }

  /** The heartbeat after a batch: saves the checkpoint and holds the lock 60 seconds more; another holder stops the run. */
  async #beat(name: string, me: string, changes: { readonly phase?: 'copy' | 'sweep'; readonly after?: string | null; readonly target?: string }): Promise<void> {
    const sets = [sql`held_until = ${this.#parts.clock.now() + LOCK_MILLISECONDS}`];
    if (changes.phase !== undefined) sets.push(sql`phase = ${changes.phase}`);
    if (changes.after !== undefined) sets.push(sql`after = ${changes.after}`);
    if (changes.target !== undefined) sets.push(sql`target = ${changes.target}`);
    const result = await sql`update search_rebuilds set ${sql.join(sets)} where index_name = ${name} and holder = ${me}`.execute(this.#db);
    if (Number(result.numAffectedRows ?? 0n) !== 1) throw new LockLost();
  }

  /** Deletes the target of a run that cannot go on, or empties it when the driver cannot delete one. */
  /** Deletes the target of a run that cannot go on, or empties it; returns a line to print when the target may still hold documents. */
  async #discard(driver: SearchDriver, info: IndexInfo, target: string): Promise<string | undefined> {
    if (driver.discard !== undefined) {
      await driver.discard(info, target);
      return undefined;
    }
    try {
      await driver.flush({ ...info, name: target });
      return undefined;
    } catch {
      // The target may be gone already, and a driver may throw for that. It is never swapped in again (a new run fills a target of
      // its own name), so a failed flush puts no document live; but the name is forgotten next, so it is printed.
      return `${info.name}: the target ${target} of the earlier run could not be emptied and may still hold its documents; delete it by hand.`;
    }
  }

  /** The keys of the next batch of rows after `after`, in the order of the key, read through the index's `source()`. */
  async #nextKeys(Index: SearchIndexClass, info: IndexInfo, after: SearchKey | undefined, batch: number): Promise<SearchKey[]> {
    const index = this.#parts.container.make(Index) as SearchIndex<object>;
    const source = (index as unknown as { source?: unknown }).source;
    if (typeof source !== 'function') throw new TypeError(`${Index.name} has no method source() on the instance the container built.`);
    type Select = {
      where(column: string, operator: '>', value: SearchKey): Select;
      orderBy(column: string): Select;
      clearOrderBy(): Select;
      limit(count: number): Select;
      execute(): Promise<unknown[]>;
    };
    const query = source.call(index, this.#parts.container.make(Database)) as Partial<Select> | null | undefined;
    if (typeof query?.where !== 'function' || typeof query.clearOrderBy !== 'function') {
      throw new TypeError(`${Index.name}.source() does not return a select of the query chain.`);
    }
    // An order of source() would come before the key and move the cursor past rows it never read: it is dropped.
    const select = (query as Select).clearOrderBy();
    const rows = await (after === undefined ? select : select.where(info.key, '>', after)).orderBy(info.key).limit(batch).execute();
    return rows.map((row) => checkKey(typeof row === 'object' && row !== null ? (row as Record<string, unknown>)[info.key] : undefined, `The column "${info.key}" of a row of ${Index.name}.source()`));
  }

  /** Copies the rows from the checkpoint on, one batch at a time, each with its checkpoint. */
  async #copy(
    Index: SearchIndexClass,
    info: IndexInfo,
    into: IndexInfo,
    driver: SearchDriver,
    me: string,
    row: RebuildRow,
    options: RebuildOptions,
    counts: { indexed: number; removed: number },
  ): Promise<void> {
    const { reader } = this.#parts;
    let after = row.after === null ? undefined : (JSON.parse(row.after) as SearchKey);
    for (;;) {
      const keys = await this.#nextKeys(Index, info, after, options.batch);
      if (keys.length === 0) break;
      const last = keys[keys.length - 1]!;
      let found: ReadResult;
      if (driver.writes === 'transaction') {
        // The batch and its checkpoint commit together: a run that stops never skips or repeats a written batch.
        found = await this.#parts.connections().transaction(async () => {
          const read = await reader.read(Index, keys);
          await write(driver, into, read);
          await this.#beat(info.name, me, { after: keyId(last) });
          return read;
        });
      } else {
        // The rows are read again after each write, and written again while they changed: a job of the same rows that wrote between
        // this read and this write would otherwise be overwritten with the older state, which a swap would then put live.
        found = await reader.read(Index, keys);
        for (let round = 1; ; round++) {
          await write(driver, into, found);
          const again = await reader.read(Index, keys);
          if (sameRead(found, again)) break;
          if (round === MAX_WRITES) {
            throw new Error(`The rows of a batch of "${info.name}" changed each of the ${MAX_WRITES} times the rebuild wrote them; run marmeon search:rebuild ${info.name} again to resume.`);
          }
          found = again;
        }
        await this.#beat(info.name, me, { after: keyId(last) });
      }
      counts.indexed += found.documents.length;
      counts.removed += found.removed.length;
      options.report(`${info.name}: ${counts.indexed} indexed, ${counts.removed} removed`);
      after = last;
      await this.#parts.hooks?.afterBatch?.('copy');
      if (keys.length < options.batch) break;
    }
  }

  /**
   * Removes the documents of the `database` driver whose rows are gone or no longer belong, in batches by row id. A document is removed
   * only with the revision it was read with, so one the app wrote again meanwhile stays.
   */
  async #sweep(Index: SearchIndexClass, info: IndexInfo, driver: DatabaseSearchDriver, me: string, from: number, options: RebuildOptions, counts: { indexed: number; removed: number }): Promise<void> {
    let after = from;
    let checked = 0;
    for (;;) {
      const result = await this.#parts.connections().transaction(async () => {
        const documents = await driver.documentsAfter(info, after, options.batch);
        if (documents.length === 0) return { read: 0, last: after, removed: 0 };
        // Tolerant: a row whose document cannot be built loses its document rather than keep an old one.
        const found = await this.#parts.reader.read(
          Index,
          documents.map((document) => document.key),
          { tolerant: true },
        );
        const gone = new Set(found.removed.map(keyId));
        await this.#parts.hooks?.beforeSweepDelete?.();
        const removed = await driver.deleteUnchanged(
          info,
          documents.filter((document) => gone.has(keyId(document.key))),
        );
        const last = documents[documents.length - 1]!.id;
        await this.#beat(info.name, me, { phase: 'sweep', after: String(last) });
        return { read: documents.length, last, removed };
      });
      if (result.read === 0) break;
      checked += result.read;
      counts.removed += result.removed;
      after = result.last;
      options.report(`${info.name}: ${checked} checked, ${counts.removed} removed`);
      await this.#parts.hooks?.afterBatch?.('sweep');
      if (result.read < options.batch) break;
    }
  }
}

import { token, type Application, type Logger, type Resolver, type Result } from '@marmeon/core';
import type { IndexInfo } from './registry.ts';
import type { ExcerptSegment, FilterScalar } from './terms.ts';

/** The key of a document: the value of the index's key column, a string of 1 to 253 characters or a safe integer. */
export type SearchKey = string | number;

/**
 * A document as a driver stores it, checked and cleaned by `Search`: the key, the canonical locale (`null` for none), the text of
 * each field that has one and the value of each filter the document carries. A filter it does not carry matches no filter.
 */
export interface StoredDocument {
  readonly key: SearchKey;
  readonly locale: string | null;
  readonly fields: Readonly<Record<string, string>>;
  readonly filters: Readonly<Record<string, FilterScalar>>;
}

/**
 * One search as a driver runs it, checked by `Search`. `tokens` holds at least one token and no syntax; `term` is the user's text,
 * normalized and cut but with its web-search syntax, so a driver only ever binds it as a parameter. `filters` names only filters every index declares, each with a value or a non-empty list of values of which a
 * document must carry one. `locale` is canonical (`pt-BR`). The driver returns the hits from `offset` on, at most `limit`.
 */
export interface DriverQuery {
  readonly indexes: readonly IndexInfo[];
  readonly tokens: readonly string[];
  readonly term: string;
  readonly filters: Readonly<Record<string, FilterScalar | readonly FilterScalar[]>>;
  readonly locale?: string | undefined;
  readonly prefix: boolean;
  readonly excerpts: boolean;
  readonly offset: number;
  readonly limit: number;
}

/**
 * One hit a driver found: the index by name, the key with the type `upsert()` got it (`42` stays a number), the score as a finite
 * number (higher is better) and, when asked for, the excerpt as segments.
 */
export interface DriverHit {
  readonly index: string;
  readonly key: SearchKey;
  readonly score: number;
  readonly excerpt?: readonly ExcerptSegment[] | undefined;
}

/** A page of hits a driver found, and how many hits there are in all (exact up to 1000). */
export interface DriverPage {
  readonly hits: readonly DriverHit[];
  readonly total: number;
}

/**
 * Why a search failed in a way an app handles: the search service cannot be reached (`unavailable`), or an index it asked for
 * does not exist there yet (`missing-index`). `message` speaks to the developer and names no secret.
 */
export interface SearchFailure {
  readonly kind: 'unavailable' | 'missing-index';
  readonly message: string;
}

/** What a driver's `inspect()` found wrong for `marmeon check`: the index it concerns, if one, what is wrong, and a command that fixes it. */
export interface SearchProblem {
  readonly index?: string | undefined;
  readonly message: string;
  readonly fix?: string | undefined;
}

/**
 * Where an index lives. `writes` says how `Search` brings changes to it: `transaction` writes in the caller's database
 * transaction, `queue` queues the job `marmeon.search.sync` that reads the rows when it runs, and `after-commit` writes once the
 * transaction committed. Every member a driver leaves out says what happens without it. See `docs/drivers.md#search-drivers`.
 */
export interface SearchDriver {
  readonly writes: 'transaction' | 'queue' | 'after-commit';
  /** Stores documents of an index, replacing those with the same keys. */
  upsert(index: IndexInfo, documents: readonly StoredDocument[]): Promise<void>;
  /** Removes the documents of these keys; a key the index does not hold is no error. */
  delete(index: IndexInfo, keys: readonly SearchKey[]): Promise<void>;
  /** Runs one search over one or more indexes; an outage or a missing index is an `err`, never a throw. */
  query(request: DriverQuery): Promise<Result<DriverPage, SearchFailure>>;
  /** Removes every document of an index. */
  flush(index: IndexInfo): Promise<void>;
  /** Runs once at the start, after the driver was built; a check that fails stops the start. Without it, nothing is checked. */
  boot?(app: Application): Promise<void>;
  /** Creates an index, or the rebuild target `target`, and applies its settings; runs again without harm. Without it, a rebuild prepares nothing. */
  prepare?(index: IndexInfo, target?: string): Promise<void>;
  /** Replaces an index with the rebuild target `target`. Without it, a rebuild writes into the index itself. */
  swap?(index: IndexInfo, target: string): Promise<void>;
  /** What `marmeon check` reports for these indexes. Without it, the check passes. */
  inspect?(indexes: readonly IndexInfo[]): Promise<readonly SearchProblem[]>;
  /** Releases what the driver holds when the app shuts down. */
  close?(): Promise<void>;
}

/** The container key of the driver `SEARCH_DRIVER` selected, built at the start. */
export const SearchDriver = token<SearchDriver>('SearchDriver');

/** What a search driver's factory is given: the name `SEARCH_DRIVER` selected it by, the container and a logger on the `search` channel. */
export interface SearchDriverContext {
  readonly name: string;
  readonly container: Resolver;
  readonly logger: Logger;
}

/** Creates the search driver a provider brings under a name (`static searchDrivers`). See `docs/drivers.md#search-drivers`. */
export type SearchDriverFactory = (context: SearchDriverContext) => SearchDriver;

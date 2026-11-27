import type { Database, SelectQuery } from '@marmeon/database';

/** How much a field counts when a search ranks its hits: `A` most, `D` least. */
export type SearchWeight = 'A' | 'B' | 'C' | 'D';

/** A value a filter compares: a document carries one per filter, and a search asks for one or for any of several. */
export type FilterValue = string | number | boolean;

/**
 * What a search index class declares besides its methods. The start checks the shape of each static and stops with Q9 when one is
 * broken; whether the key column exists shows only when rows are read. See `docs/full-text-search.md#defining-an-index`.
 */
export interface SearchIndexStatics {
  /** The stored name of the index: lowercase letters, digits, `_` and `-`, starting with a letter, at most 64 characters. */
  readonly index: string;
  /** The column of the source rows that identifies a document; its values are strings or safe integers. */
  readonly key: string;
  /** The fields a search looks in, by name, each with its weight: 1 to 32 of them. */
  readonly fields: Readonly<Record<string, SearchWeight>>;
  /** The attributes a search may filter by: up to 32 names, never `locale`. */
  readonly filters?: readonly string[];
  /** The database connection of the source rows; only `default` is supported. */
  readonly connection?: 'default';
}

/** A search index class: the statics of {@link SearchIndexStatics} and a constructor the container calls. */
export type SearchIndexClass<I extends SearchIndex<any> = SearchIndex<any>> = SearchIndexStatics & (new (...args: any[]) => I);

/** The row type an index class reads from its source, taken from its `toDocument()`. */
type IndexRow<I extends SearchIndexClass> = InstanceType<I>['toDocument'] extends (row: infer Row) => unknown ? Row : never;

/** The type of an index's key: the type of the key column in its rows, narrowed to a string or a number. */
export type KeyOf<I extends SearchIndexClass> = I['key'] extends keyof IndexRow<I> ? Extract<IndexRow<I>[I['key']], string | number> : string | number;

/** The names of the fields an index declares. */
export type FieldsOf<I extends SearchIndexClass> = DeclaredFields<I>;

/**
 * The names of the filters an index declares; for a union of indexes, the names of any of them. A list written without `as const`
 * declares no name the type can know, so it counts as none, and every filter is a type error instead of every name passing.
 */
export type FilterNamesOf<I extends SearchIndexClass> = DeclaredFilters<I>;

// The two below read the statics structurally, without the constraint `SearchIndexClass`: checking that constraint inside the
// return type of a class's own toDocument() compares the class with itself and never ends.
type DeclaredFields<I> = I extends { readonly fields: infer Fields } ? keyof Fields & string : never;
type DeclaredFilters<I> = I extends { readonly filters: infer List } ? (List extends readonly unknown[] ? KnownNames<List[number]> : never) : never;

/** The literal names of a declared filter list; `string`, from a list written without `as const`, is none. */
type KnownNames<Name> = string extends Name ? never : Name & string;

/** The filter names every index of the union `I` declares. */
type CommonFilterNames<I extends SearchIndexClass> =
  FilterNamesOf<I> extends infer Name ? (Name extends string ? (false extends (I extends SearchIndexClass ? (Name extends FilterNamesOf<I> ? true : false) : never) ? never : Name) : never) : never;

/**
 * The filters a search over the indexes `I` takes: only names every one of them declares, each with one value or a non-empty list of
 * values of which a document must carry one. See `docs/full-text-search.md#searching`.
 */
export type FiltersOf<I extends SearchIndexClass> = [CommonFilterNames<I>] extends [never]
  ? NoFilters
  : { readonly [Name in CommonFilterNames<I>]?: FilterValue | readonly [FilterValue, ...FilterValue[]] };

/** No filter at all: an empty mapped type would be `{}`, which takes any key without an error. */
type NoFilters = { readonly [name: string]: never };

/**
 * What `toDocument()` of the index class `I` returns for one row: its locale (`null` for none), the text of the declared fields and
 * the values of the declared filters. An undeclared field or filter is a type error. See `docs/full-text-search.md#defining-an-index`.
 */
export interface SearchDocument<I extends SearchIndexStatics> {
  readonly locale?: string | null;
  readonly fields: Partial<Record<DeclaredFields<I>, string | null>>;
  readonly filters?: [DeclaredFilters<I>] extends [never] ? NoFilters : Partial<Record<DeclaredFilters<I>, FilterValue>>;
}

/** @internal The document of any index, as the base class returns it: field and filter names are not known here. */
export interface AnyDocument {
  readonly locale?: string | null;
  readonly fields: Partial<Record<string, string | null>>;
  readonly filters?: Partial<Record<string, FilterValue>>;
}

/**
 * The base of a search index: the statics say what is searched, `source()` which rows, `includes()` whether a row belongs in the
 * index and `toDocument()` what of it is searched. Registered in a module's `searchIndexes` or a provider's `static searchIndexes`,
 * and built by the container. See `docs/full-text-search.md#defining-an-index`.
 */
export abstract class SearchIndex<Row extends object = Record<string, unknown>> {
  /**
   * The rows of the index, as a select of the query chain. `selectAll()` leaves out a column its migration marks `secret()`, and a
   * select that names one other than through `secret()` is refused.
   */
  abstract source(db: Database): SelectQuery<any, any, Row>;

  /** Whether a row belongs in the index, such as only a published page; a row it refuses is removed. Every row belongs without it. */
  includes?(row: Row): boolean;

  /** The document of one row: the text of each field, the filter values and the locale. */
  abstract toDocument(row: Row): AnyDocument;
}

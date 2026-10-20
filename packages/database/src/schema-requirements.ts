/** Columns a table must have for the code to run; readiness is red until the database has them. */
export interface TableRequirement {
  readonly connection: string;
  readonly table: string;
  readonly columns: readonly string[];
  /** Columns that must be marked `.secret()` in the migrations: readiness is red while a table has one unmarked (a table made by hand). */
  readonly secrets?: readonly string[];
  /** Only checked when the table exists: an app that never made it (the feature is unused) stays ready, one with a table that lacks a column does not. */
  readonly whenPresent?: true;
}

/**
 * The tables the packages need columns of, per connection. A package registers its requirement when its database driver is the
 * one in use; readiness compares them with the database. See `docs/package-development.md#tables`.
 *
 * A singleton of the `DatabaseServiceProvider`: take it with `container.make(SchemaRequirements)` once `container.has(Connections)`.
 */
export class SchemaRequirements {
  readonly #requirements: TableRequirement[] = [];

  /** @internal Packages take the instance from the container. */
  constructor() {}

  /** Registers a table the package reads or writes; readiness compares it with the database as {@link TableRequirement} describes. */
  require(requirement: TableRequirement): void {
    this.#requirements.push(requirement);
  }

  /** Every requirement registered so far, in the order of registration. */
  all(): readonly TableRequirement[] {
    return this.#requirements;
  }
}

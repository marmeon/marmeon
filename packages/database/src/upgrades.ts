import type { ServiceProviderClass } from '@marmeon/core';

/**
 * A migration that brings a set of framework tables — `queue`, `cache`, … — to a newer revision. A package lists them as
 * `static migrationUpgrades` on its provider; `marmeon make:upgrade-migrations` writes the missing ones into the app.
 * See `docs/migrations.md#upgrading-the-frameworks-tables`.
 */
export interface MigrationUpgrade {
  /** The set of tables — `queue`, `cache`, … — as the stub's `// @marmeon-stub <set> <revision>` names it. */
  readonly set: string;
  /** The revision this migration brings the set to (the first stub is revision 1). */
  readonly revision: number;
  /** The file name without timestamp: `rename_queue_tables_to_marmeon`. */
  readonly name: string;
  /** The names (without timestamp) of the migrations that created the set — where the app keeps it. */
  readonly createdBy: readonly string[];
  /** The file the command writes; its first line is the `// @marmeon-stub <set> <revision>` mark. */
  readonly contents: string;
}

/** Columns a table must have for the code to run; readiness is red until the database has them. */
export interface TableRequirement {
  readonly connection: string;
  readonly table: string;
  readonly columns: readonly string[];
  /** The set of tables the requirement belongs to, as in {@link MigrationUpgrade.set}. */
  readonly set: string;
}

const MARK = /^\/\/ @marmeon-stub (\S+) (\d+)\r?\n/;

/** The set and revision a migration file declares in its first line; none for a file the app wrote itself. */
export function stubMark(contents: string): { set: string; revision: number } | undefined {
  const found = MARK.exec(contents);
  return found ? { set: found[1]!, revision: Number(found[2]) } : undefined;
}

const SET = /^[a-z][a-z0-9-]*$/;
const NAME = /^[a-z][a-z0-9_]*$/;

/**
 * The upgrades the providers bring, by set and in revision order. Stops on what would write a wrong file: a name that is no
 * plain migration name (a path), a revision below 2, a mark that disagrees with the entry, or the same revision of a set
 * from two providers.
 */
export function collectUpgrades(providers: readonly ServiceProviderClass[]): Map<string, readonly MigrationUpgrade[]> {
  const bySet = new Map<string, Map<number, { upgrade: MigrationUpgrade; provider: string }>>();
  for (const Provider of providers) {
    const provider = Provider.name || 'a provider';
    for (const upgrade of Provider.migrationUpgrades ?? []) {
      const label = `${provider} lists the migration upgrade "${upgrade.name}" (${upgrade.set}, revision ${upgrade.revision})`;
      if (!SET.test(upgrade.set)) throw new TypeError(`${label}: the set must be a lowercase name like "queue".`);
      if (!NAME.test(upgrade.name)) throw new TypeError(`${label}: the name must be a file name without timestamp or path, like "rename_queue_tables" — got "${upgrade.name}".`);
      for (const created of upgrade.createdBy) {
        if (!NAME.test(created)) throw new TypeError(`${label}: createdBy must list file names without timestamp or path — got "${created}".`);
      }
      if (!Number.isInteger(upgrade.revision) || upgrade.revision < 2) throw new TypeError(`${label}: the revision must be an integer from 2 — the first stub is revision 1.`);
      const mark = stubMark(upgrade.contents);
      if (mark?.set !== upgrade.set || mark.revision !== upgrade.revision) {
        throw new TypeError(`${label}: its contents must start with the line "// @marmeon-stub ${upgrade.set} ${upgrade.revision}".`);
      }
      let revisions = bySet.get(upgrade.set);
      if (!revisions) bySet.set(upgrade.set, (revisions = new Map()));
      const taken = revisions.get(upgrade.revision);
      if (taken) throw new TypeError(`${taken.provider} and ${provider} both list revision ${upgrade.revision} of the "${upgrade.set}" tables ("${taken.upgrade.name}" and "${upgrade.name}").`);
      revisions.set(upgrade.revision, { upgrade, provider });
    }
  }
  return new Map([...bySet].map(([set, revisions]) => [set, [...revisions.values()].map((entry) => entry.upgrade).toSorted((a, b) => a.revision - b.revision)]));
}

/**
 * The tables the framework's packages need columns of, per connection. A package registers its requirement when its database
 * driver is the one in use; `DatabaseHealthCheck` compares them with the database.
 * @internal
 */
export class SchemaRequirements {
  readonly #requirements: TableRequirement[] = [];

  require(requirement: TableRequirement): void {
    this.#requirements.push(requirement);
  }

  all(): readonly TableRequirement[] {
    return this.#requirements;
  }
}

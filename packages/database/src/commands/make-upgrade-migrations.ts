import { readFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { Application } from '@marmeon/core';
import type { CommandInput } from 'marmeon';
import { collectUpgrades, stubMark, type MigrationUpgrade } from '../upgrades.ts';
import { findMigration, publishMigration } from './publish-migration.ts';

/**
 * `marmeon make:upgrade-migrations [--check]`: writes the migrations that bring the framework's tables in your app to the
 * revision of the installed packages, each into the module that holds the migration that created the set. It reads the
 * revision from the `// @marmeon-stub` line of your migration files and needs no database. `--check` writes nothing and
 * exits with 1 when a migration is missing. Then `marmeon migrate`. See `docs/migrations.md#upgrading-the-frameworks-tables`.
 */
export class MakeUpgradeMigrationsCommand {
  static command = 'make:upgrade-migrations';
  static description = "Write the migrations that bring the framework's tables to the installed revision (--check: fail if one is missing)";
  static usage = '[--check]';
  static options = { check: { type: 'boolean' } } as const;

  readonly #app: Application;

  constructor(app: Application) {
    this.#app = app;
  }

  handle(input: CommandInput): number {
    const modules = join(input.root, 'modules');
    const missing: { upgrade: MigrationUpgrade; module: string }[] = [];
    const problems: string[] = [];
    for (const [set, upgrades] of collectUpgrades(this.#app.providers)) {
      const created = [...new Set(upgrades.flatMap((upgrade) => upgrade.createdBy))].map((name) => findMigration(modules, name)).filter((file) => file !== undefined);
      // A set the app does not use (its driver is not chosen) has no migration to upgrade.
      if (created.length === 0) continue;
      const module = basename(dirname(dirname(created[0]!)));
      // Files without the line are the first revision; a file of revision N already has everything up to N.
      let have = 1;
      for (const file of created) {
        const mark = stubMark(readFileSync(file, 'utf8'));
        if (mark && mark.set !== set) problems.push(`${relative(input.root, file)} is marked for the "${mark.set}" tables, not "${set}".`);
        else if (mark) have = Math.max(have, mark.revision);
      }
      const known = upgrades.at(-1)!.revision;
      if (have > known) problems.push(`Your app has revision ${have} of ${set}, the installed packages know up to ${known} — update the packages.`);
      // A revision is never written behind a later one that is there: the migrator would run them in the wrong order.
      let absent: number | undefined;
      for (const upgrade of upgrades) {
        if (upgrade.revision <= have) continue;
        if (!findMigration(modules, upgrade.name)) {
          missing.push({ upgrade, module });
          absent ??= upgrade.revision;
        } else if (absent !== undefined) {
          problems.push(`Revision ${upgrade.revision} of the "${set}" tables is in your app, but revision ${absent} is not — restore ${absent} ("${upgrades.find((candidate) => candidate.revision === absent)!.name}") by hand, in front of it.`);
        }
      }
    }
    if (problems.length > 0) {
      for (const problem of problems) input.output.error(problem);
      return 1;
    }

    if (missing.length === 0) {
      input.output.success("The framework's tables have every migration of the installed packages.");
      return 0;
    }
    if (input.options.check === true) {
      input.output.error("Migrations for the framework's tables are missing — run marmeon make:upgrade-migrations:");
      for (const { upgrade } of missing) input.output.line(`  ${upgrade.set} revision ${upgrade.revision}: ${upgrade.name}`);
      return 1;
    }

    // One second apart and in revision order: the migrator runs them by name, and a revision needs the one before it. None is missing behind a later one (checked above).
    const start = Date.now();
    let code = 0;
    for (const [index, { upgrade, module }] of missing.entries()) {
      code ||= publishMigration(input, { name: upgrade.name, contents: upgrade.contents, table: upgrade.set, module, at: new Date(start + index * 1000) });
    }
    return code;
  }
}

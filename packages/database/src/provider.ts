import { Application, Logger, type Container, type ServiceProvider } from '@marmeon/core';
import type { AppCheckClass, CommandClass } from 'marmeon';
import { PublishCommand } from './commands/publish.ts';
import { DbTypesCheck, PackageMigrationsCheck } from './checks.ts';
import { DbShowCommand } from './commands/db-show.ts';
import { MigrateCommand, MigrateFreshCommand, MigrateResetCommand, MigrateRollbackCommand, MigrateStatusCommand } from './commands/migrate.ts';
import { DbSeedCommand } from './commands/db-seed.ts';
import { DbTypesCommand } from './commands/db-types.ts';
import type { ProviderMigrations } from './package-migrations.ts';
import { Factories } from './factories.ts';
import { Seeding } from './seeders.ts';
import { Migrator } from './migrations/migrator.ts';
import { databaseSolutions } from './solutions.ts';
import { DatabaseHealthCheck } from './health.ts';
import { SchemaRequirements } from './schema-requirements.ts';
import { TypeGenerator } from './types-gen/generator.ts';

declare module '@marmeon/core' {
  interface ModuleDefinition {
    /**
     * The module's migrations directory: `new URL('./migrations/', import.meta.url)` (or a path
     * relative to the app root). Files are named `2026_10_01_120000_create_users_table.ts`.
     */
    readonly migrations?: URL | string;
  }

  interface ServiceProviderClass {
    /**
     * The directory of the migrations the provider's package ships, and the module they go to:
     * `{ from: new URL('../stubs/migrations', import.meta.url), module: 'permissions' }`. `marmeon publish` copies them into an app.
     * See `docs/package-development.md#declaring-the-migrations-a-package-ships`.
     */
    readonly migrations?: ProviderMigrations;
  }
}
import { DatabaseConfig, isConnectionDefinition, type ConnectionDefinition, type ConnectionOptions } from './config.ts';
import { withCode } from '@marmeon/core/internal';
import { Connections, Database } from './connections.ts';

/**
 * Registers `Connections` and the default `Database`, adds `db:*` commands to the CLI (when it is
 * installed) and closes every connection on shutdown. Found by `marmeon discover`.
 */
export class DatabaseServiceProvider implements ServiceProvider {
  static config = [DatabaseConfig];
  /** A missing table → the pending migrations, on the development error page. */
  static solutions = databaseSolutions;
  /** Every connection answers `select 1`, for `/up/ready`. */
  static health = [DatabaseHealthCheck];
  /** `bootstrap/database.d.ts` matches the migrations, for `marmeon check`. */
  static checks: readonly AppCheckClass[] = [PackageMigrationsCheck, DbTypesCheck];
  static commands: readonly CommandClass[] = [DbShowCommand, DbTypesCommand, DbSeedCommand, MigrateCommand, MigrateRollbackCommand, MigrateResetCommand, MigrateFreshCommand, MigrateStatusCommand, PublishCommand];

  register(container: Container): void {
    container.singleton(SchemaRequirements);
    container.singleton(Connections, (c) => {
      const app = c.make(Application);
      // Named connections are config definitions listed by the app or a module (`defineConnection`).
      const named = [
        ...(app.definition.config ?? []).map((definition) => ({ definition, source: 'the application' })),
        ...app.modules.flatMap((module) => (module.config ?? []).map((definition) => ({ definition, source: `module "${module.name}"` }))),
      ].filter((entry): entry is { definition: ConnectionDefinition; source: string } => isConnectionDefinition(entry.definition));
      const connections: Record<string, ConnectionOptions> = { default: c.make(DatabaseConfig).default };
      const seen = new Map<string, { definition: ConnectionDefinition; source: string }>();
      for (const entry of named) {
        const first = seen.get(entry.definition.connection);
        // One definition listed by the app and by a module that needs it is one connection.
        if (first?.definition === entry.definition) continue;
        if (first !== undefined) {
          throw new Error(withCode('D23', `The database connection "${entry.definition.connection}" is defined twice, by two different definitions: in ${first.source} and in ${entry.source}. Rename one of them.`));
        }
        seen.set(entry.definition.connection, entry);
        connections[entry.definition.connection] = c.make(entry.definition);
      }
      return new Connections({ connections, root: app.root, logger: c.make(Logger), app });
    });
    container.singleton(Database, (c) => c.make(Connections).get());
    container.singleton(Migrator);
    container.singleton(TypeGenerator);
    container.singleton(Factories);
    container.singleton(Seeding);
  }

  boot(app: Application): void {
    app.container.make(Connections).verify();
  }

  async shutdown(app: Application): Promise<void> {
    await app.container.make(Connections).destroy();
  }
}

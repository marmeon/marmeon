import { Application, Logger, type Container, type ServiceProvider } from '@marmeon/core';
import { DbShowCommand } from './commands/db-show.ts';
import { MigrateCommand, MigrateFreshCommand, MigrateResetCommand, MigrateRollbackCommand, MigrateStatusCommand } from './commands/migrate.ts';
import { DbSeedCommand } from './commands/db-seed.ts';
import { DbTypesCommand } from './commands/db-types.ts';
import { Factories } from './factories.ts';
import { Seeding } from './seeders.ts';
import { Migrator } from './migrations/migrator.ts';
import { databaseSolutions } from './solutions.ts';
import { DatabaseHealthCheck } from './health.ts';
import { TypeGenerator } from './types-gen/generator.ts';

declare module '@marmeon/core' {
  interface ModuleDefinition {
    /**
     * The module's migrations directory: `new URL('./migrations/', import.meta.url)` (or a path
     * relative to the app root). Files are named `2026_10_01_120000_create_users_table.ts`.
     */
    readonly migrations?: URL | string;
  }
}
import { DatabaseConfig, isConnectionDefinition, type ConnectionOptions } from './config.ts';
import { Connections, Database } from './connections.ts';

/**
 * Registers `Connections` and the default `Database`, adds `db:*` commands to the CLI (when it is
 * installed) and closes every connection on shutdown. Found by `marmeon discover`.
 */
export class DatabaseServiceProvider implements ServiceProvider {
  static config = [DatabaseConfig];
  /** A missing table → the pending migrations, on the development error page (E130). */
  static solutions = databaseSolutions;
  /** Every connection answers `select 1`, for `/up/ready` (E126). */
  static health = [DatabaseHealthCheck];

  register(container: Container): void {
    container.singleton(Connections, (c) => {
      const app = c.make(Application);
      // Named connections are config definitions listed by the app or a module (`defineConnection`).
      const named = [...(app.options.config ?? []), ...app.modules.flatMap((module) => module.config ?? [])].filter(isConnectionDefinition);
      const connections: Record<string, ConnectionOptions> = { default: c.make(DatabaseConfig).default };
      for (const definition of named) connections[definition.connection] = c.make(definition);
      return new Connections({ connections, root: app.root, logger: c.make(Logger), app });
    });
    container.singleton(Database, (c) => c.make(Connections).get());
    container.singleton(Migrator);
    container.singleton(TypeGenerator);
    container.singleton(Factories);
    container.singleton(Seeding);
  }

  async boot(app: Application): Promise<void> {
    app.container.make(Connections).verify();
    const cli = await import('marmeon').catch(() => undefined);
    if (cli && app.container.has(cli.CommandRegistry)) {
      app.container
        .make(cli.CommandRegistry)
        .add([DbShowCommand, DbTypesCommand, DbSeedCommand, MigrateCommand, MigrateRollbackCommand, MigrateResetCommand, MigrateFreshCommand, MigrateStatusCommand]);
    }
  }

  async shutdown(app: Application): Promise<void> {
    await app.container.make(Connections).destroy();
  }
}

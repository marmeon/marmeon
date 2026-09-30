import { Application, Logger, type Container, type ServiceProvider } from '@bespokecore/core';
import { DbShowCommand } from './commands/db-show.ts';
import { DatabaseConfig, isConnectionDefinition, type ConnectionOptions } from './config.ts';
import { Connections, Database } from './connections.ts';

/**
 * Registers `Connections` and the default `Database`, adds `db:*` commands to the CLI (when it is
 * installed) and closes every connection on shutdown. Found by `bespoke discover`.
 */
export class DatabaseServiceProvider implements ServiceProvider {
  static config = [DatabaseConfig];

  register(container: Container): void {
    container.singleton(Connections, (c) => {
      const app = c.make(Application);
      // Named connections are config definitions listed by the app or a module (`defineConnection`).
      const named = [...(app.options.config ?? []), ...app.modules.flatMap((module) => module.config ?? [])].filter(isConnectionDefinition);
      const connections: Record<string, ConnectionOptions> = { default: c.make(DatabaseConfig).default };
      for (const definition of named) connections[definition.connection] = c.make(definition);
      return new Connections({ connections, root: app.root, logger: c.make(Logger) });
    });
    container.singleton(Database, (c) => c.make(Connections).get());
  }

  async boot(app: Application): Promise<void> {
    app.container.make(Connections).verify();
    const cli = await import('@bespokecore/cli').catch(() => undefined);
    if (cli && app.container.has(cli.CommandRegistry)) app.container.make(cli.CommandRegistry).add([DbShowCommand]);
  }

  async shutdown(app: Application): Promise<void> {
    await app.container.make(Connections).destroy();
  }
}

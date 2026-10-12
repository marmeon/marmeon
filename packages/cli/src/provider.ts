import type { Application, Container, ServiceProvider } from '@marmeon/core';
import { CommandRegistry, type CommandClass } from './command.ts';
import { DevProcesses } from './dev.ts';

declare module '@marmeon/core' {
  interface ModuleDefinition {
    /** Console commands this module adds to `marmeon`. */
    readonly commands?: readonly CommandClass[];
  }
}

/**
 * Collects the modules' commands. Packages add theirs in `boot()`:
 * `app.container.make(CommandRegistry).add([MyCommand], '@acme/my-package')`.
 */
export class CliServiceProvider implements ServiceProvider {
  register(container: Container): void {
    container.singleton(CommandRegistry);
    container.singleton(DevProcesses);
  }

  boot(app: Application): void {
    const registry = app.container.make(CommandRegistry);
    for (const module of app.modules) registry.add(module.commands ?? [], `module ${module.name}`);
  }
}

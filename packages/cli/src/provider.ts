import type { Application, Container, ServiceProvider } from '@bespokecore/core';
import { CommandRegistry, type CommandClass } from './command.ts';
import { DevProcesses } from './dev.ts';

declare module '@bespokecore/core' {
  interface ModuleDefinition {
    /** Console commands this module adds to `bespoke`. */
    readonly commands?: readonly CommandClass[];
  }
}

/**
 * Collects the modules' commands. Packages add theirs in `boot()`:
 * `app.container.make(CommandRegistry).add([MyCommand])`.
 */
export class CliServiceProvider implements ServiceProvider {
  register(container: Container): void {
    container.singleton(CommandRegistry);
    container.singleton(DevProcesses);
  }

  boot(app: Application): void {
    app.container.make(CommandRegistry).add(app.modules.flatMap((module) => module.commands ?? []));
  }
}

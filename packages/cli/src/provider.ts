import { Application, type Container, type ServiceProvider } from '@marmeon/core';
import { BUILT_IN } from './built-in.ts';
import { CommandRegistry, type CommandClass } from './command.ts';
import { DevProcesses } from './dev.ts';

declare module '@marmeon/core' {
  interface ModuleDefinition {
    /** Console commands this module adds to `marmeon`. */
    readonly commands?: readonly CommandClass[];
  }

  interface ServiceProviderClass {
    /** Console commands this provider adds to `marmeon` — how a package brings its commands. See docs/package-development.md#commands. */
    readonly commands?: readonly CommandClass[];
  }
}

/**
 * Collects every command while the app registers — built-ins, providers' `static commands`, modules' `commands` — so
 * `marmeon build` sees them all and a name used twice stops the app before it boots.
 */
export class CliServiceProvider implements ServiceProvider {
  register(container: Container): void {
    // `Application` is bound before any provider registers, so resolving it here depends on no other provider.
    const app = container.make(Application);
    const registry = new CommandRegistry().add(BUILT_IN, 'marmeon');
    for (const Provider of app.providers) registry.add(Provider.commands ?? [], Provider.name || 'a provider');
    for (const module of app.modules) registry.add(module.commands ?? [], `module ${module.name}`);
    container.instance(CommandRegistry, registry);
    container.singleton(DevProcesses);
  }
}

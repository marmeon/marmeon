import { Application, type Container, type ServiceProvider } from '@marmeon/core';
import { BUILT_IN } from './built-in.ts';
import { CommandRegistry, type CommandClass } from './command.ts';
import { DevProcesses } from './dev.ts';
import { ModulesCheck } from './check/modules.ts';
import { RouteTypesCheck } from './check/route-types.ts';
import { CheckRegistry, type AppCheckClass } from './check/registry.ts';

declare module '@marmeon/core' {
  interface ModuleDefinition {
    /** Console commands this module adds to `marmeon`. */
    readonly commands?: readonly CommandClass[];
    /** Checks this module adds to `marmeon check`. */
    readonly checks?: readonly AppCheckClass[];
  }

  interface ServiceProviderClass {
    /** Console commands this provider adds to `marmeon` — how a package brings its commands. See docs/package-development.md#commands. */
    readonly commands?: readonly CommandClass[];
    /** Checks this provider adds to `marmeon check` — how a package brings its checks. See docs/package-development.md#checks. */
    readonly checks?: readonly AppCheckClass[];
  }
}

/**
 * Collects every command and check while the app registers — built-ins, providers' `static commands` and `static checks`,
 * modules' `commands` and `checks` — so `marmeon build` sees them all and a name used twice stops the app before it boots.
 */
export class CliServiceProvider implements ServiceProvider {
  /** The checks of the app's own files: route types and unlisted classes. */
  static checks: readonly AppCheckClass[] = [RouteTypesCheck, ModulesCheck];

  register(container: Container): void {
    // `Application` is bound before any provider registers, so resolving it here depends on no other provider.
    const app = container.make(Application);
    const registry = new CommandRegistry().add(BUILT_IN, 'marmeon');
    for (const Provider of app.providers) registry.add(Provider.commands ?? [], Provider.name || 'a provider');
    for (const module of app.modules) registry.add(module.commands ?? [], `module ${module.name}`);
    container.instance(CommandRegistry, registry);
    const checks = new CheckRegistry();
    for (const Provider of app.providers) checks.add(Provider.checks ?? [], Provider.name || 'a provider');
    for (const module of app.modules) checks.add(module.checks ?? [], `module ${module.name}`);
    container.instance(CheckRegistry, checks);
    container.singleton(DevProcesses);
  }
}

import { createApplication, defineModule, type ApplicationPhase, type ModuleDefinition, type ServiceProvider, type ServiceProviderClass } from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import { CommandRegistry, CommandSetupError, type CommandClass } from './command.ts';
import { CliServiceProvider } from './provider.ts';

function named(name: string, label = name): CommandClass {
  return class {
    static readonly command = name;
    static readonly description = label;
    handle(): void {}
  };
}

const PkgCommand = Object.defineProperty(named('pkg:run'), 'name', { value: 'PkgCommand' });
const ModuleCommand = Object.defineProperty(named('mod:run'), 'name', { value: 'ModuleCommand' });

class PkgProvider implements ServiceProvider {
  static commands = [PkgCommand];
  boot(): void {
    throw new Error('booted');
  }
}

function moduleWith(...commands: CommandClass[]): ModuleDefinition {
  return defineModule({ name: 'x', commands });
}

function appWith(phase: ApplicationPhase, options: { providers?: ServiceProviderClass[]; modules?: ModuleDefinition[] } = {}) {
  return createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: options.providers ?? [CliServiceProvider, PkgProvider],
    modules: options.modules ?? [],
  }, { env: {}, phase });
}

describe.each<ApplicationPhase>(['build', 'run'])('CliServiceProvider in the %s phase', (phase) => {
  it('collects built-ins, provider commands and module commands while registering', async () => {
    // In the build phase nothing boots — PkgProvider's boot() would throw; the run phase boots, so it uses a quiet provider.
    class Quiet {
      static commands = [PkgCommand];
    }
    const providers = phase === 'build' ? [CliServiceProvider, PkgProvider] : [CliServiceProvider, Quiet];
    const app = await appWith(phase, { providers, modules: [moduleWith(ModuleCommand)] });
    const registry = app.container.make(CommandRegistry);
    expect(registry.get('pkg:run')).toBe(PkgCommand);
    expect(registry.get('mod:run')).toBe(ModuleCommand);
    expect(registry.get('route:list')).toBeDefined();
  });

  it('collects the same without the provider order mattering', async () => {
    class Quiet {
      static commands = [PkgCommand];
    }
    const app = await createApplication({ root: import.meta.dirname, discover: false, providers: [Quiet, CliServiceProvider] }, { env: {}, phase });
    expect(app.container.make(CommandRegistry).get('pkg:run')).toBe(PkgCommand);
  });

  it('refuses a module command that takes a provider command name', async () => {
    class Quiet {
      static commands = [PkgCommand];
    }
    const Clash = Object.defineProperty(named('pkg:run'), 'name', { value: 'ClashCommand' });
    const failed = createApplication({ root: import.meta.dirname, discover: false, providers: [CliServiceProvider, Quiet], modules: [moduleWith(Clash)] }, { env: {}, phase });
    await expect(failed).rejects.toBeInstanceOf(CommandSetupError);
    await expect(failed).rejects.toThrow('Two commands are named "pkg:run": PkgCommand (Quiet) and ClashCommand (module x)');
  });

  it('names the built-in first when a module takes its name', async () => {
    const Clash = Object.defineProperty(named('route:list'), 'name', { value: 'OursCommand' });
    await expect(createApplication({ root: import.meta.dirname, discover: false, providers: [CliServiceProvider], modules: [moduleWith(Clash)] }, { env: {}, phase })).rejects.toThrow(
      'Two commands are named "route:list": RouteListCommand (marmeon) and OursCommand (module x)',
    );
  });

  it('keeps one entry when a provider and a module list the same class', async () => {
    class Quiet {
      static commands = [PkgCommand];
    }
    const app = await createApplication({ root: import.meta.dirname, discover: false, providers: [CliServiceProvider, Quiet], modules: [moduleWith(PkgCommand)] }, { env: {}, phase });
    expect(app.container.make(CommandRegistry).all().filter((command) => command === PkgCommand)).toHaveLength(1);
  });

  it.each(['list', 'help'])('refuses a module command named %s', async (name) => {
    await expect(createApplication({ root: import.meta.dirname, discover: false, providers: [CliServiceProvider], modules: [moduleWith(named(name))] }, { env: {}, phase })).rejects.toThrow(
      "is marmeon's own command",
    );
  });
});

import { describe, expect, it } from 'vitest';
import { CommandRegistry, CommandSetupError, type CommandClass } from './command.ts';

function named(name: string, label: string): CommandClass {
  return class {
    static readonly command = name;
    static readonly description = label;
    handle(): void {}
  };
}

describe('CommandRegistry.add', () => {
  it('keeps one entry when the same class is added twice', () => {
    const Seed = named('db:seed', 'seed');
    const registry = new CommandRegistry().add([Seed], '@marmeon/database').add([Seed], 'module app');
    expect(registry.all()).toEqual([Seed]);
  });

  it('refuses a second class under a taken name and names both classes and sources', () => {
    class AppSeed {
      static readonly command = 'db:seed';
      static readonly description = 'app';
      handle(): void {}
    }
    class PackageSeed {
      static readonly command = 'db:seed';
      static readonly description = 'package';
      handle(): void {}
    }
    const registry = new CommandRegistry().add([PackageSeed], '@acme/seeds');
    expect(() => registry.add([AppSeed], 'module app')).toThrow(CommandSetupError);
    expect(() => registry.add([AppSeed], 'module app')).toThrow('Two commands are named "db:seed": PackageSeed (@acme/seeds) and AppSeed (module app).');
    expect(registry.get('db:seed')).toBe(PackageSeed);
  });

  it('works without a source', () => {
    const registry = new CommandRegistry().add([named('a:b', 'one')]);
    expect(() => registry.add([named('a:b', 'two')])).toThrow('(a package)');
  });
});

describe('CommandRegistry.owner', () => {
  it('returns the class and where it comes from, undefined for an unknown name', () => {
    const Seed = named('db:seed', 'seed');
    const registry = new CommandRegistry().add([Seed], 'DatabaseServiceProvider');
    expect(registry.owner('db:seed')).toEqual({ command: Seed, source: 'DatabaseServiceProvider' });
    expect(registry.owner('db:fresh')).toBeUndefined();
  });
});

describe('CommandRegistry reserved names', () => {
  it.each(['list', 'help'])('refuses %s, which marmeon answers itself', (name) => {
    expect(() => new CommandRegistry().add([named(name, 'ours')], 'module x')).toThrow(`"${name}" is marmeon's own command`);
  });
});

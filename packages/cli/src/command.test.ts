import { describe, expect, it } from 'vitest';
import { CommandArgumentsError, CommandRegistry, CommandSetupError, parseCommandArgs, type CommandClass } from './command.ts';

function named(name: string, label: string): CommandClass {
  return class {
    static readonly command = name;
    static readonly description = label;
    handle(): void {}
  };
}

describe('CommandRegistry.add', () => {
  it('begins the messages of its two refusals with K8', () => {
    const Seed = named('db:seed', 'seed');
    const Other = named('db:seed', 'other');
    expect(() => new CommandRegistry().add([Seed]).add([Other])).toThrow(/^\[marmeon:K8\] Two commands are named/);
    expect(() => new CommandRegistry().add([named('list', 'x')])).toThrow(/^\[marmeon:K8\] "list" is marmeon's own command/);
  });

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

  it('refuses a module that still carries a command a package took over, and the package keeps the name', () => {
    const FromPackage = named('auth:end-sessions', 'package');
    const FromModule = named('auth:end-sessions', 'module');
    const registry = new CommandRegistry().add([FromPackage], 'AuthServiceProvider');
    expect(() => registry.add([FromModule], 'module auth')).toThrow(/^\[marmeon:K8\] Two commands are named "auth:end-sessions"/);
    expect(registry.get('auth:end-sessions')).toBe(FromPackage);
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

describe('parseCommandArgs', () => {
  it('wraps a caller’s mistake, but not a broken option definition', () => {
    const wrong = { command: 'x', options: { force: { type: 'boolean' } } } as unknown as CommandClass;
    expect(() => parseCommandArgs(wrong, ['--nope'])).toThrow(CommandArgumentsError);
    const broken = { command: 'x', options: { force: { type: 'boolean', short: 'ab' } } } as unknown as CommandClass;
    expect(() => parseCommandArgs(broken, [])).toThrow(TypeError);
    expect(() => parseCommandArgs(broken, [])).not.toThrow(CommandArgumentsError);
  });
});

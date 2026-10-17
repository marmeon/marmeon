import { describe, expect, it } from 'vitest';
import { CheckRegistry, CheckSetupError, type AppCheckClass } from './registry.ts';

const check = (name: string, phase: 'build' | 'run' = 'build', label = 'Check'): AppCheckClass => {
  const Class = class {
    static check = name;
    static phase = phase;
    handle() {
      return [];
    }
  };
  Object.defineProperty(Class, 'name', { value: label });
  return Class;
};

describe('CheckRegistry', () => {
  it('lists the checks of a phase in registration order', () => {
    const registry = new CheckRegistry().add([check('b', 'run'), check('a')], 'one').add([check('c', 'run')], 'two');
    expect(registry.all('build').map((found) => found.check)).toEqual(['a']);
    expect(registry.all('run').map((found) => found.check)).toEqual(['b', 'c']);
  });

  it('takes the same class twice as one', () => {
    const same = check('same');
    expect(new CheckRegistry().add([same], 'one').add([same], 'two').all('build')).toHaveLength(1);
  });

  it('refuses a name taken by another class, naming both with their sources', () => {
    const registry = new CheckRegistry().add([check('dup', 'build', 'First')], 'AProvider');
    expect(() => registry.add([check('dup', 'run', 'Second')], 'module blog')).toThrow(
      new CheckSetupError('Two checks are named "dup": First (AProvider) and Second (module blog). Rename one — its static check is how marmeon finds it.'),
    );
  });

  it.each(['types', 'lint', 'internal-imports', 'boot', 'readiness'])('refuses %s, a name marmeon uses itself', (name) => {
    expect(() => new CheckRegistry().add([check(name)], 'AProvider')).toThrow(CheckSetupError);
  });

  it.each(['Foo', 'foo bar', 'foo_bar', '-foo', 'foo-', '1foo', ''])('refuses the name %j', (name) => {
    expect(() => new CheckRegistry().add([check(name)], 'AProvider')).toThrow(/kebab-case/);
  });

  it('refuses a check without a phase, and a class without a name', () => {
    const noPhase = check('ok');
    (noPhase as { phase: unknown }).phase = 'later';
    expect(() => new CheckRegistry().add([noPhase], 'AProvider')).toThrow(/static phase/);
    expect(() => new CheckRegistry().add([class {} as unknown as AppCheckClass], 'AProvider')).toThrow(/kebab-case/);
  });

  it('is a CommandSetupError, so a name used twice stops the app for `list` too', () => {
    expect(() => new CheckRegistry().add([check('types')], 'x')).toThrow(expect.objectContaining({ name: 'CheckSetupError' }));
  });
});

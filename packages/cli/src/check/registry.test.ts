import { describe, expect, it } from 'vitest';
import type { Duration } from '@marmeon/core';
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

  it('takes a static timeout as seconds or parts up to ten minutes, and refuses more (K13)', () => {
    const timed = (timeout: unknown): AppCheckClass => Object.assign(check('timed'), { timeout }) as AppCheckClass;
    expect(new CheckRegistry().add([timed(0.05)]).all('build')).toHaveLength(1);
    expect(new CheckRegistry().add([timed({ milliseconds: 500 })]).all('build')).toHaveLength(1);
    expect(new CheckRegistry().add([timed({ minutes: 10 })]).all('build')).toHaveLength(1);
    expect(() => new CheckRegistry().add([timed(5000)], 'module blog')).toThrow(/\[marmeon:K13\].*a check of `marmeon check`.*for 5000 ms write `\{ milliseconds: 5000 \}`/);
    expect(() => new CheckRegistry().add([timed('2s')], 'module blog')).toThrow(/Check \(module blog\) has a .static timeout. that is no span of time/);
    expect(() => new CheckRegistry().add([timed(0)])).toThrow(/\[marmeon:K13\].*above zero/);
    expect(() => new CheckRegistry().add([timed({ seconds: -1 })])).toThrow(/\[marmeon:K13\]/);
    class Typed {
      static check = 'typed';
      static phase = 'build' as const;
      // @ts-expect-error a string is no span of time
      static timeout: Duration = '2s';
      handle() {
        return [];
      }
    }
    expect(() => new CheckRegistry().add([Typed])).toThrow(CheckSetupError);
  });

  it('takes the same class twice as one', () => {
    const same = check('same');
    expect(new CheckRegistry().add([same], 'one').add([same], 'two').all('build')).toHaveLength(1);
  });

  it('refuses a name taken by another class, naming both with their sources', () => {
    const registry = new CheckRegistry().add([check('dup', 'build', 'First')], 'AProvider');
    expect(() => registry.add([check('dup', 'run', 'Second')], 'module blog')).toThrow(
      new CheckSetupError('[marmeon:K11] Two checks are named "dup": First (AProvider) and Second (module blog). Rename one — its static check is how marmeon finds it.'),
    );
  });

  it.each(['types', 'lint', 'internal-imports', 'agents', 'boot', 'readiness'])('refuses %s, a name marmeon uses itself', (name) => {
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

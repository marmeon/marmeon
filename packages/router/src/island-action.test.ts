import { ISLAND_CONTROLLER } from '@marmeon/core/internal';
import { describe, expect, it } from 'vitest';
import { isIslandAction } from './internal.ts';

const marker = Symbol.for(ISLAND_CONTROLLER);

describe('isIslandAction', () => {
  it('is true for a controller class the loader marked, also for a subclass that inherits the mark', () => {
    class Marked {
      static [marker] = true;
      handle() {}
    }
    class Child extends Marked {}
    expect(isIslandAction(Marked as never)).toBe(true);
    expect(isIslandAction(Child as never)).toBe(true);
  });

  it('is false for a controller class without the mark', () => {
    class Page {
      handle() {}
    }
    expect(isIslandAction(Page as never)).toBe(false);
  });

  it('is false for a closure, also one that carries the mark', () => {
    const closure = () => 'x';
    expect(isIslandAction(closure as never)).toBe(false);
    expect(isIslandAction(Object.assign(() => 'x', { [marker]: true }) as never)).toBe(false);
  });

  it('needs the mark to be exactly true', () => {
    class Odd {
      static [marker] = 'yes';
      handle() {}
    }
    expect(isIslandAction(Odd as never)).toBe(false);
  });
});

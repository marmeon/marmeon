import { describe, expect, it } from 'vitest';
import { SharedData } from './shared-data.ts';

declare module './page.ts' {
  interface SharedProps {
    locale: string;
    counter: number;
  }
}

describe('SharedData', () => {
  it('resolves plain and lazy values — a lazy one at most once per request', async () => {
    let evaluated = 0;
    const shared = new SharedData().share('locale', 'de').share('counter', async () => ++evaluated);
    expect(shared.has('counter')).toBe(true);
    expect(await shared.resolve()).toEqual({ locale: 'de', counter: 1 });
    expect(await shared.resolve()).toEqual({ locale: 'de', counter: 1 });
    expect(evaluated).toBe(1);
  });

  it('throws the first failure only once every other lazy prop has settled', async () => {
    const events: string[] = [];
    const shared = new SharedData()
      .share('locale', () => {
        throw new Error('locale failed');
      })
      .share('counter', async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        events.push('counter settled');
        return 1;
      });
    await expect(shared.resolve()).rejects.toThrow('locale failed');
    events.push('rejected');
    expect(events).toEqual(['counter settled', 'rejected']);
  });

  it('checks keys and values against SharedProps', () => {
    const shared = new SharedData();
    // @ts-expect-error -- `locale` is a string
    shared.share('locale', 1);
    // @ts-expect-error -- `theme` is not a shared prop
    shared.share('theme', 'dark');
    // @ts-expect-error -- a lazy value must produce the declared type
    shared.share('counter', () => 'one');
    expect(shared.has('theme')).toBe(true); // at runtime anything goes — the compiler guards it
  });
});

// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://app.test/users/1" }
import { defineFeature, loadHistoryFallback, type Navigator } from '@marmeon/http/client';
import type { PageObject } from '@marmeon/http/page';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MarmeonApp, RouterContext, useFeature, useRouterContext, type RouterValue } from './app.tsx';

// happy-dom has no Navigation API: the History fallback — as createMarmeonApp loads it in such a browser.
const HISTORY = [await loadHistoryFallback()];

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** `useFeature`: what an adapter component uses of a feature of the client core, attached on first use. */

const page: PageObject = { component: 'users/Show', props: {}, url: '/users/1', version: null };

describe('useFeature', () => {
  it('attaches a feature once per navigator — every component, every render gets the same API', async () => {
    const setup = vi.fn(() => ({ id: Symbol('api') }));
    const counter = defineFeature('counter', setup);
    const seen: unknown[] = [];
    let navigator: Navigator | null = null;
    let rerender!: () => void;
    function Uses() {
      const [, set] = useState(0);
      rerender = () => set((count) => count + 1);
      navigator = useRouterContext().navigator();
      seen.push(useFeature(counter), useFeature(counter));
      return null;
    }
    const Show = () => (
      <>
        <Uses />
        <Uses />
      </>
    );
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(<MarmeonApp features={HISTORY} initialPage={page} initialComponent={Show} resolve={async () => Show} />));
    await act(async () => rerender());
    expect(seen.length).toBeGreaterThanOrEqual(6);
    expect(new Set(seen).size).toBe(1);
    expect(setup).toHaveBeenCalledTimes(1);
    expect(setup).toHaveBeenCalledWith(expect.objectContaining({ navigator }));
    expect(navigator!.use(counter)).toBe(seen[0]);
    await act(async () => root.unmount());
  });

  it('says where it runs while rendering on the server — there is no navigator', () => {
    const router = { navigator: () => null } as unknown as RouterValue;
    function Uses() {
      useFeature(defineFeature('islands', () => 'api'));
      return null;
    }
    expect(() =>
      renderToString(
        <RouterContext.Provider value={router}>
          <Uses />
        </RouterContext.Provider>,
      ),
    ).toThrow('useFeature(islands): the islands feature runs in the browser — there is no navigator while rendering on the server. Use it in a component that renders in the browser only.');
  });
});

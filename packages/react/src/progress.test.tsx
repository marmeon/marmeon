// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://app.test/a" }
import { PAGE_HEADER, type PageObject } from '@marmeon/http/protocol';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarmeonApp, progressIndicator, useRouter } from './app.tsx';
import { progressBar, type ProgressIndicator } from './index.ts';
import { resolveModulePages, type PageComponent } from './pages.ts';
import { loadHistoryFallback } from '@marmeon/http/client/adapter';

// happy-dom has no Navigation API: the History fallback — as createMarmeonApp loads it in such a browser.
const HISTORY = [await loadHistoryFallback()];

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function A() {
  const { visit } = useRouter();
  return <button type="button" data-testid="go" onClick={() => void visit('/b')}>B</button>;
}
const B = () => <p data-page="b">B</p>;
const pages: Record<string, PageComponent> = { A, B };
const resolve = resolveModulePages(Object.fromEntries(Object.entries(pages).map(([name, page]) => [`/modules/app/views/${name}.tsx`, async () => ({ default: page })])));
const page = (name: string, url: string): PageObject => ({ component: `app/${name}`, props: {}, url, version: null });

let answer: () => void;
let root: Root;
let container: HTMLElement;

beforeEach(() => {
  history.replaceState(null, '', '/a');
  container = document.createElement('div');
  document.body.replaceChildren(container);
  // A slow server: the visit is under way until the test answers it.
  vi.spyOn(window, 'fetch').mockImplementation(
    () => new Promise((resolved) => (answer = () => resolved(new Response(JSON.stringify(page('B', '/b')), { headers: { [PAGE_HEADER]: 'true' } })))),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
});

async function mount(progress?: ProgressIndicator) {
  root = createRoot(container);
  const Component = await resolve('app/A');
  await act(async () => root.render(<MarmeonApp features={HISTORY} initialPage={page('A', '/a')} initialComponent={Component} resolve={resolve} {...(progress ? { progress } : {})} />));
}
const wait = (ms: number) => act(async () => void (await new Promise((resolve) => setTimeout(resolve, ms))));
const bar = () => document.querySelector('[data-marmeon-progress]');

describe('the progress bar is opt-in', () => {
  it('progressBar() shows the core’s bar while a slow visit is under way', async () => {
    await mount(progressBar({ delay: 0 }));
    await act(async () => (container.querySelector('[data-testid="go"]') as HTMLElement).click());
    await wait(20);
    expect(bar()).not.toBeNull();
    expect(document.documentElement.getAttribute('aria-busy')).toBe('true');
    await act(async () => answer());
    await wait(600);
    expect(bar()).toBeNull();
    expect(document.documentElement.hasAttribute('aria-busy')).toBe(false);
  });

  it('without it, a slow visit shows no bar — aria-busy still says a visit runs', async () => {
    await mount();
    await act(async () => (container.querySelector('[data-testid="go"]') as HTMLElement).click());
    await wait(300);
    expect(bar()).toBeNull();
    expect(document.documentElement.getAttribute('aria-busy')).toBe('true');
    await act(async () => answer());
    await wait(10);
  });

  it('takes the app’s own indicator — started with the navigator, stopped with the app', async () => {
    const calls: string[] = [];
    await mount((navigator) => {
      const off = navigator.on('start', (visit) => calls.push(`start ${visit.url}`));
      return () => (off(), calls.push('stopped'));
    });
    await act(async () => (container.querySelector('[data-testid="go"]') as HTMLElement).click());
    await act(async () => answer());
    await act(async () => root.unmount());
    expect(calls).toEqual(['start /b', 'stopped']);
    root = createRoot(container);
  });

  it('options or false for progress say what to import instead', () => {
    // @ts-expect-error — progress takes an indicator: progressBar({ delay: 250 })
    const before: Parameters<typeof MarmeonApp>[0]['progress'] = { delay: 250 };
    expect(() => progressIndicator(before)).toThrow("[marmeon:R16] progress takes an indicator: createMarmeonApp({ progress: progressBar({ delay: 250 }) }) — import { progressBar } from '@marmeon/react'.");
    // @ts-expect-error — leave progress out for none
    const off: Parameters<typeof MarmeonApp>[0]['progress'] = false;
    expect(() => progressIndicator(off)).toThrow('[marmeon:R16]');
    expect(progressIndicator(undefined)).toBeUndefined();
  });
});

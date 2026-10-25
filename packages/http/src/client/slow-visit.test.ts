/**
 * A slow visit in development: a plain GET visit that leaves nothing new on screen for more than a second (no placeholder,
 * nothing fetched ahead) draws one console warning (C14) per route and document — never in production.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { instant } from './features/instant.ts';
import { prefetch } from './features/prefetch.ts';
import { boot, FakeWindow, ORIGIN, page, pageResponse } from './test-window.ts';

/** A tab whose server answers after `delayMs` (fake timers). */
function tab(delayMs = 1500) {
  const win = new FakeWindow(`${ORIGIN}/a`);
  win.handler = async (url) => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return pageResponse(page(new URL(url).pathname, {}));
  };
  return boot(win, page('/a', {}));
}

type Tab = ReturnType<typeof tab>['navigator'];

/** Runs a visit through the fake clock until it ends. */
async function visit(navigator: Tab, url: string, options: Parameters<Tab['visit']>[1] = {}, advanceMs = 2000) {
  const visiting = navigator.visit(url, options);
  await vi.advanceTimersByTimeAsync(advanceMs);
  await visiting;
}

describe('slow visit warning', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.useFakeTimers();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    warn.mockRestore();
  });

  it('warns once for a visit slower than a second — a second one to the same route stays quiet', async () => {
    const { navigator } = tab();
    await visit(navigator, '/b', { name: 'people.show' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/^\[marmeon:C14\] The visit to people\.show took 1500 ms with nothing new on screen/);
    expect(warn.mock.calls[0]![0]).toContain('docs/navigation.md#instant-visits');
    await visit(navigator, '/c', { name: 'people.show' });
    expect(warn).toHaveBeenCalledTimes(1);
    await visit(navigator, '/d', { name: 'people.index' });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('names the path of a visit without a route name — once per path', async () => {
    const { navigator } = tab();
    await visit(navigator, '/b');
    await visit(navigator, '/b');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('The visit to /b took');
  });

  it('keys a visit by the route the server answered with — two URLs of one route warn once', async () => {
    const win = new FakeWindow(`${ORIGIN}/a`);
    win.handler = async (url) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return pageResponse({ ...page(new URL(url).pathname, {}), route: 'people.show' });
    };
    const { navigator } = boot(win, page('/a', {}));
    await visit(navigator, '/people/1');
    await visit(navigator, '/people/2');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('The visit to people.show took');
  });

  it('stays quiet for a visit under a second', async () => {
    const { navigator } = tab(500);
    await visit(navigator, '/b', {}, 600);
    expect(warn).not.toHaveBeenCalled();
  });

  it('stays quiet when a placeholder shows, the visit is `async`, or it is a partial reload', async () => {
    const { navigator } = tab();
    navigator.use(instant);
    await visit(navigator, '/b', { instant: { component: 'pages/Show' } });
    await visit(navigator, '/c', { async: true });
    await visit(navigator, '/d', { only: ['x'] });
    expect(warn).not.toHaveBeenCalled();
  });

  it('stays quiet when the page was fetched ahead', async () => {
    const { navigator } = tab();
    const prefetching = navigator.use(prefetch).prefetch('/b');
    await vi.advanceTimersByTimeAsync(2000);
    await prefetching;
    await visit(navigator, '/b');
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([['production'], [undefined]])('NODE_ENV=%j: no warning', async (value) => {
    vi.stubEnv('NODE_ENV', value);
    const { navigator } = tab();
    await visit(navigator, '/b');
    expect(warn).not.toHaveBeenCalled();
  });
});

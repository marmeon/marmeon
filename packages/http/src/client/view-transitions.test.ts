/**
 * View transitions: a page change animates in `document.startViewTransition` — the page loaded first, only its
 * swap in the update, the history entry and the scroll after it is in; types for the direction and the app's own. Skipped under
 * reduced motion, in a hidden tab, without the API; never two (an adapter that starts them itself gets the types instead). Runs on
 * the Navigation API's path and on the History fallback's.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PageObject } from '../protocol.ts';
import { guard } from './features/guard.ts';
import { loadViewTransitions } from './lazy.ts';
import { Navigator, type ViewTransitionOption } from './navigation.ts';
import { boot, FakeWindow, historyFeatures, ORIGIN, page, pageResponse, PATHS, settle } from './test-window.ts';

/** A layer's page object. */
const layer = (url: string): PageObject => ({ ...page(url, {}, 'users/Edit'), layer: { key: 'users/Edit', base: '/a' } });

/** A tab whose server answers every URL with a page of that path (a layer for `/edit`) — the document has view transitions. */
function tab({ viewTransition, transitions = true, ...options }: { viewTransition?: ViewTransitionOption | 'adapter'; transitions?: boolean } & Parameters<typeof boot>[2] = {}) {
  const win = new FakeWindow(`${ORIGIN}/a`);
  if (transitions) win.supportViewTransitions();
  win.handler = (url) => {
    const { pathname } = new URL(url);
    return pageResponse(pathname === '/edit' ? layer(pathname) : page(pathname, { at: pathname }, pathname === '/b2' ? 'pages/Other' : 'pages/Show'));
  };
  const app = boot(win, page('/a', { at: '/a' }), { ...options, ...(viewTransition === undefined ? {} : { viewTransition }) });
  return { win, ...app };
}

/** Lets a Back/Forward (a task later), its transition and its render finish. */
const settled = async (rounds = 6) => {
  for (let i = 0; i < rounds; i++) await settle();
};

const typesOf = (win: FakeWindow) => win.transitions.map((transition) => transition.types.join(' '));

describe.each(PATHS)('view transitions on the %s path', (path) => {
  beforeEach(() => void (FakeWindow.path = path));
  afterEach(() => void (FakeWindow.path = 'navigation'));

  describe('around the swap — loaded first, the entry and the scroll once the new page is in', () => {
    it('runs the render in the update; the history entry and the scroll follow it — one entry, never on the old page', async () => {
      const { win, navigator, visible } = tab();
      win.scrollTo(0, 300);
      win.log.length = 0;
      const entries = win.entries.length;
      await navigator.visit('/b', { viewTransition: true });

      expect(typesOf(win)).toEqual(['forward']);
      expect(win.entries.length, 'the history entry was written more than once').toBe(entries + 1);
      // The order: the old page captured, the new one rendered in the update — then its entry, then the top of the page.
      // (The History fallback writes the entry left first — where it was scrolled to.)
      expect(win.log.slice(win.log.indexOf('transition forward')), 'the history entry or the scroll came before the new page was in').toEqual(['transition forward', 'render /b', 'updated', 'push /b', 'scroll 0']);
      expect(visible().url).toBe('/b');
      await settled();
      expect(win.transitions[0]).toMatchObject({ updated: true, skipped: false });
    });

    it('adds the app’s types to the direction — and replaces with `replace`', async () => {
      const { win, navigator } = tab();
      await navigator.visit('/b', { viewTransition: { types: ['slide'] } });
      await navigator.visit('/c', { viewTransition: true, replace: true });
      expect(typesOf(win)).toEqual(['slide forward', 'replace']);
    });

    it('loads its code with the first visit that asks for one — never for a visit that does not', async () => {
      const { navigator } = tab();
      await navigator.visit('/b');
      expect(navigator.loaded(loadViewTransitions), 'view transitions loaded without being asked for').toBeUndefined();
      await navigator.visit('/c', { viewTransition: true });
      expect(navigator.loaded(loadViewTransitions)).toBeDefined();
    });

    it('a page whose code cannot load: the browser loads it, as without a transition', async () => {
      const win = new FakeWindow(`${ORIGIN}/a`);
      win.supportViewTransitions();
      win.handler = () => pageResponse(page('/b'));
      // A render that throws (a chunk gone after a deployment) — inside the update.
      const navigator = new Navigator({
        initialPage: page('/a'),
        window: win,
        render: async (next) => {
          if (next.url === '/b') throw new Error('chunk gone');
        },
        features: historyFeatures(win),
      });
      navigator.start();
      await navigator.visit('/b', { viewTransition: true });
      expect(win.loads).toEqual(['assign https://app.test/b']);
    });
  });

  describe('the app’s (NavigatorOptions.viewTransition) — page changes, not what keeps the page', () => {
    it('animates every visit that takes the page off the screen — not a partial reload, one in the background, or `false`', async () => {
      const { win, navigator } = tab({ viewTransition: true });
      await navigator.visit('/b');
      await navigator.visit('/b', { only: ['at'] });
      await navigator.visit('/b', { preserveState: true, replace: true });
      await navigator.visit('/c', { async: true });
      await navigator.visit('/d', { viewTransition: false });
      await navigator.visit('/e', { viewTransition: { types: ['slide'] } });
      expect(typesOf(win)).toEqual(['forward', 'slide forward']);
    });

    it('Back is `back`, Forward `forward` — from memory, and from the server', async () => {
      const { win, navigator, visible } = tab({ viewTransition: true });
      await navigator.visit('/b');
      await navigator.visit('/c');
      win.back();
      await settled();
      win.back();
      await settled();
      win.forward();
      await settled();
      expect(visible().url).toBe('/b');
      expect(typesOf(win), 'Back/Forward did not animate as `back`/`forward`').toEqual(['forward', 'forward', 'back', 'back', 'forward']);
    });

    it('a visit’s own on a page entered with one — Back from it and Forward to it animate alike; others do not', async () => {
      const { win, navigator } = tab();
      await navigator.visit('/b', { viewTransition: { types: ['slide'] } });
      await navigator.visit('/c');
      win.back();
      await settled();
      win.back();
      await settled();
      win.forward();
      await settled();
      expect(typesOf(win), 'Back from the page entered with a transition did not animate as `back`').toEqual(['slide forward', 'slide back', 'slide forward']);
    });
  });

  describe('skipped — the swap runs as without', () => {
    it('when the user prefers reduced motion', async () => {
      const { win, navigator, visible } = tab({ viewTransition: true });
      win.reducedMotion = true;
      await navigator.visit('/b', { viewTransition: true });
      win.back();
      await settled();
      expect(win.transitions, 'a view transition under prefers-reduced-motion: reduce').toEqual([]);
      expect(visible().url).toBe('/a');
    });

    it('in a hidden tab', async () => {
      const { win, navigator, visible } = tab();
      win.hide();
      await navigator.visit('/b', { viewTransition: true });
      expect(win.transitions, 'a view transition in a hidden tab').toEqual([]);
      expect(visible().url).toBe('/b');
    });

    it('without the API — and in a browser without types (an object throws)', async () => {
      const without = tab({ transitions: false });
      await without.navigator.visit('/b', { viewTransition: true });
      expect(without.visible().url).toBe('/b');

      const old = new FakeWindow(`${ORIGIN}/a`);
      old.supportViewTransitions({ types: false });
      old.handler = () => pageResponse(page('/b'));
      const app = boot(old, page('/a'));
      await app.navigator.visit('/b', { viewTransition: true });
      expect(app.visible().url).toBe('/b');
      expect(old.current.url).toBe(`${ORIGIN}/b`);
    });
  });

  describe('never two, never against the guard, never for a layer', () => {
    it('an adapter that starts them itself gets the types with the render — the core starts none', async () => {
      const { win, navigator, renders } = tab({ viewTransition: 'adapter' });
      await navigator.visit('/b');
      await navigator.visit('/c', { viewTransition: { types: ['slide'] } });
      win.back();
      await settled();
      expect(win.transitions, 'the core started a view transition beside the adapter’s').toEqual([]);
      expect(renders.map((render) => [render.page.url, render.transition?.join(' ')])).toEqual([
        ['/b', 'forward'],
        ['/c', 'slide forward'],
        ['/b', 'back'],
      ]);
    });

    it('the guard asks first — a visit it stops starts no transition', async () => {
      const { win, navigator, visible } = tab({ viewTransition: true, confirm: () => false });
      const lift = navigator.use(guard).add({ message: 'Unsaved changes.' });
      await navigator.visit('/b');
      expect(win.transitions).toEqual([]);
      expect(visible().url).toBe('/a');
      lift();
      await navigator.visit('/b');
      expect(typesOf(win)).toEqual(['forward']);
    });

    it('a new visit skips the animation still running', async () => {
      const { win, navigator } = tab();
      await navigator.visit('/b', { viewTransition: true });
      // The first one's update is done, its animation runs: the next visit starts.
      await navigator.visit('/c');
      expect(win.transitions[0]!.skipped, 'the running transition was not skipped').toBe(true);
    });

    it('a layer opening, closing by Back, and coming back by Forward is no page change — a page visit from under it is', async () => {
      const { win, navigator } = tab({ viewTransition: true });
      await navigator.visit('/edit', { layer: true });
      win.back();
      await settled();
      win.forward();
      await settled();
      expect(win.transitions, 'a layer transitioned').toEqual([]);
      await navigator.visit('/b');
      expect(typesOf(win)).toEqual(['forward']);
    });
  });
});

/**
 * View transitions: a page change animates. The navigator loads the page first, then this feature wraps only the swap in
 * `document.startViewTransition({ update, types })` — the history entry and the scroll position follow as soon as the new page
 * is in (after `updateCallbackDone`, before the new state is captured). See docs/navigation.md#view-transitions.
 *
 * Skipped when the user prefers reduced motion, the tab is hidden or the browser has none: a transition freezes the page until
 * the swap, which is only worth it for an animation someone sees. Layers are no page change (their frame animates itself).
 */
import { defineFeature, slot } from '../feature.ts';
import type { ViewTransitionLike, ViewTransitionOption } from '../navigation.ts';

/** What the feature tells an app: the view transition animating now (none while none runs, and never in an adapter's). */
export interface ViewTransitions {
  readonly running: ViewTransitionLike | undefined;
}

/**
 * The types a page was entered with by a visit's own `viewTransition` — Back from it (and Forward to it) animates alike. Per
 * history entry: memory lets go of it with the entry.
 */
const ENTERED = slot(
  'viewTransition',
  () => ({ types: undefined as readonly string[] | undefined }),
  (entered) => void (entered.types = undefined),
);

/** The types an option asks for — none when it is off. */
const typesOf = (option: ViewTransitionOption | 'adapter' | 'react' | undefined): readonly string[] | undefined =>
  option === true || typeof option === 'string' ? [] : option ? (option.types ?? []) : undefined;

export const viewTransitions = defineFeature(
  'viewTransitions',
  (host) => {
    const { window: win, options } = host;
    let running: ViewTransitionLike | undefined;
    /** The types handed to the adapter's render — while the swap's render starts (`extras`). */
    let handed: readonly string[] | undefined;
    /** The Back/Forward under way: whether it goes back, the page it leaves and the one it goes to. */
    let traversal: { back: boolean; from: string | undefined; to: string } | undefined;
    /** Where in the tab's history the entry on screen is — the Navigation API's index, or the History fallback's count. */
    const position = (): number => win.navigation?.currentEntry?.index ?? ((host.history.state as { index?: number } | undefined)?.index ?? 0);
    let shown = position();
    /** The types the page swapped in now was entered with (a visit's own) — kept with its entry once it has one (`page`). */
    let entering: readonly string[] | undefined;

    host.on('page', () => {
      shown = position();
      if (entering) host.entry(ENTERED).types = entering;
      entering = undefined;
    });
    host.on('popped', () => void (shown = position()));
    // A Back/Forward: the Navigation API says where it came from; the History fallback moved already — the count of the entry left.
    host.on('popState', (state) => {
      traversal = { back: (win.navigation?.transition?.from.index ?? shown) > position(), from: host.key, to: state.layer?.below[0] ?? state.key };
    });
    /**
     * The view transition of the visit whose page lands now — its own (`viewTransition`), or undefined: the app's. A visit that keeps
     * the page (a partial reload, "load more", one in the background) has none of the app's.
     */
    let landing: ViewTransitionOption | undefined;
    host.on('start', ({ options: own, keeps }) => {
      // A new visit: the animation still running ends (its page is in place already).
      if (!own.async) running?.skipTransition();
      return { landed: () => void (landing = own.async ? false : (own.viewTransition ?? (keeps ? false : undefined))), end: () => void (landing = undefined) };
    });
    host.on('extras', () => (handed ? { transition: handed } : {}));
    host.on('swap', (run, how, keep) => {
      let types: readonly string[] | undefined;
      if (how === 'traverse') {
        const going = traversal;
        traversal = undefined;
        // The app's — or the types the page was entered with: Back from it, Forward to it.
        types = going && (typesOf(options.viewTransition) ?? host.peek(ENTERED, going.back ? going.from! : going.to)?.types);
        types &&= [...types, going!.back ? 'back' : 'forward'];
      } else {
        // The visit's own — or the app's, for a page change that takes the page off the screen.
        const own = landing;
        landing = undefined;
        entering = typesOf(own);
        types = own === undefined ? (keep ? undefined : typesOf(options.viewTransition)) : entering;
        types &&= [...types, how === 'push' ? 'forward' : 'replace'];
      }
      const doc = win.document;
      if (!types || !doc?.startViewTransition || doc.visibilityState === 'hidden' || win.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return undefined;
      return transition(run, types);
    });

    /** Runs the swap in a view transition — the adapter's (it starts it), or the core's. */
    function transition(run: () => Promise<void>, types: readonly string[]): Promise<void> {
      // The adapter starts them (`'adapter'`, React's `'react'`).
      if (typeof options.viewTransition === 'string') {
        // The render reads the types when it starts — synchronously, at the swap's first step.
        handed = types;
        try {
          return run();
        } finally {
          handed = undefined;
        }
      }
      running?.skipTransition();
      let started: ViewTransitionLike;
      try {
        started = win.document!.startViewTransition!({ update: run, types: [...types] });
      } catch {
        // A browser without types (Chrome before 125, Safari before 18.2): no transition.
        return run();
      }
      running = started;
      const ended = () => void (running === started && (running = undefined));
      started.finished.then(ended, ended);
      // Skipped (a newer one, the tab hidden): no animation — not an error.
      started.ready.catch(ended);
      return started.updateCallbackDone;
    }

    return {
      get running() {
        return running;
      },
    } satisfies ViewTransitions;
  },
  0,
);

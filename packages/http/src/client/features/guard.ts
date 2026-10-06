/**
 * The navigation guard and confirmations (E64): unsaved changes a visit, Back/Forward or closing a layer would lose ask
 * first; closing the tab or reloading gets the browser's own question (`beforeunload`). A full load the server asks for (a
 * 409) is never stopped. Attached where a component guards (React: `useBlocker`, a form's `guard`) — a visit's own
 * confirmation (`confirm`) is the core's, asked with or without it.
 */
import { DEFAULT_LEAVE_MESSAGE } from '../confirm.ts';
import type { FeatureHost } from '../core.ts';
import { defineFeature, type PendingVisit } from '../feature.ts';
import type { HistoryState, NavigateEvent } from '../history.ts';
import type { Layer } from '../layer.ts';

/**
 * Unsaved changes that a navigation would lose (E64) — `navigator.use(guard).add({ message })`: while it is registered (and `active()`
 * says so), a visit, Back/Forward or closing its layer asks first, and closing the tab or reloading gets the browser's own
 * question (`beforeunload`). `layer`: the layer it is in — only what takes that layer (or the page beneath) off the screen
 * asks; without one, it is the page's.
 */
export interface NavigationGuard {
  /** What to ask (the browser's `beforeunload` question has its own words). */
  readonly message?: string;
  /** The layer it is in (undefined: the page). */
  readonly layer?: Layer;
  /** Whether it guards right now (default: while registered). */
  active?(): boolean;
}

type GuardCore = Pick<FeatureHost, 'window' | 'key' | 'layers' | 'left' | 'started' | 'ask' | 'mayLeave'>;

/** The guards of one navigator. */
export class Guards {
  readonly #core: GuardCore;
  /** Unsaved changes (E64): what a navigation asks about first. */
  readonly #guards = new Set<NavigationGuard>();
  /** The user chose to leave: the traversal to this entry (the Navigation API's key) passes the guards. */
  #passing: string | undefined;
  /** The user chose to leave for another site (or a full load): the browser's own question does not ask again. */
  #unloadAllowed = false;

  constructor(core: GuardCore) {
    this.#core = core;
  }

  /**
   * Whether a visit may start (the `visit` hook — after the core asked its own confirmation): the unsaved changes it would take
   * off the screen — a promise only when something is asked, so a visit nobody guards starts at once.
   */
  check({ options: { ignoreGuards }, keeps, leaving }: PendingVisit): boolean | Promise<boolean> {
    return keeps || ignoreGuards === true || this.blocking(leaving, ignoreGuards).length === 0 || this.#core.mayLeave(leaving, ignoreGuards);
  }

  /**
   * Guards unsaved changes (E64) until the returned function lifts it: from now on — while `guard.active()` says so — a visit,
   * Back/Forward or closing its layer asks first (`guard.message`), and closing the tab or reloading asks with the browser's own
   * question. A form passes its own guard when it is sent (`ignoreGuards`); a full page load the server asks for (a 409: signed
   * out, a new build) is never stopped.
   */
  add(guard: NavigationGuard): () => void {
    const { window } = this.#core;
    this.#guards.add(guard);
    if (this.#guards.size === 1 && this.#core.started) window.addEventListener('beforeunload', this.#onBeforeUnload);
    return () => {
      if (!this.#guards.delete(guard)) return;
      if (this.#guards.size === 0) window.removeEventListener('beforeunload', this.#onBeforeUnload);
    };
  }

  /** The navigator took over the history: guarded changes now ask before the tab closes. */
  start(): void {
    if (this.#guards.size > 0) this.#core.window.addEventListener('beforeunload', this.#onBeforeUnload);
  }

  stop(): void {
    this.#core.window.removeEventListener('beforeunload', this.#onBeforeUnload);
  }

  /** The user chose to leave (another site, a full load): the browser's own question does not ask again. */
  allowUnload(): void {
    this.#unloadAllowed = true;
  }

  /** The active guards on the levels `leaving` says go — but `ignore`. */
  blocking(leaving: (level: number) => boolean, ignore: readonly NavigationGuard[] = []): NavigationGuard[] {
    if (this.#core.left) return [];
    return [...this.#guards].filter((guard) => {
      if (ignore.includes(guard) || !(guard.active?.() ?? true)) return false;
      const level = this.#levelOf(guard);
      return level >= 0 && leaving(level);
    });
  }

  /**
   * Back/Forward to `state` (the Navigation API's `navigate`, E184), before the navigator follows it: whether the guard takes it —
   * unsaved changes on what it would take off the screen. Cancelled where the browser lets it (the same document, with a fresh
   * user activation — or from a script): the URL never changes. Otherwise it goes, and goes back at once to the entry it left
   * (`traverseTo` by the browser's key — no counted index: right after a reload or a session restore too). Then it asks; Leave
   * traverses again. Two Backs in a row escape the cancel (the activation is used up) — never the guard. `closing`: a layer closes
   * by going back — its close asked already.
   */
  navigate(event: NavigateEvent, state: HistoryState, closing: boolean): boolean {
    const { window, layers, key } = this.#core;
    const to = event.destination.key;
    const passing = this.#passing === to;
    this.#passing = undefined;
    if (closing || passing) return false;
    const target = new Set<string>([state.key, ...(state.layer?.below ?? [])]);
    const blocking = this.blocking((level) => !target.has(level === 0 ? key! : layers[level - 1]!.entry));
    if (blocking.length === 0) return false;
    const navigation = window.navigation!;
    if (event.cancelable) event.preventDefault();
    else {
      // It commits first — then back where it was (the navigator lets that traversal pass: the entry is on screen).
      const from = navigation.currentEntry!.key;
      event.intercept({ scroll: 'manual', focusReset: 'manual', handler: () => navigation.traverseTo(from) });
    }
    void this.#core.ask({ kind: 'leave', message: blocking[0]!.message ?? DEFAULT_LEAVE_MESSAGE }).then((leave) => {
      if (!leave || this.#core.left) return;
      this.#passing = to;
      // A task later: a traversal the browser is still cancelling refuses another one (`InvalidStateError`, Chrome 154).
      setTimeout(() => navigation.traverseTo(to));
    });
    return true;
  }

  /** The level a guard is at: 0 the page, 1… its layer's depth on screen — -1 when its layer is gone. */
  #levelOf(guard: NavigationGuard): number {
    if (!guard.layer) return 0;
    const index = this.#core.layers.indexOf(guard.layer);
    return index < 0 ? -1 : index + 1;
  }

  /** Closing the tab or reloading with guarded changes: the browser's own question (it ignores the message). Never for a full load the server asked for (409). */
  readonly #onBeforeUnload = (event: Event): void => {
    if (this.#core.left || this.#unloadAllowed || this.blocking(() => true).length === 0) return;
    event.preventDefault();
    (event as unknown as { returnValue: unknown }).returnValue = '';
  };
}

/**
 * The navigation guard (E64) as a feature: asks before a visit (its confirmation, unsaved changes), cancels (or undoes) a
 * Back/Forward it stops, says what is unsaved to the core (a postponed new build, closing a layer) and the browser's own question. Holds no
 * data — only the guards the app registers.
 */
export const guard = defineFeature('guard', (host) => {
  const guards = new Guards(host);
  host.on('visit', (visit) => guards.check(visit));
  host.on('unsaved', (leaving, ignore) => guards.blocking(leaving, ignore));
  host.on('navigate', (event, state, own) => guards.navigate(event, state, own) || undefined);
  host.on('started', () => guards.start());
  host.on('stopped', () => guards.stop());
  host.on('unload', () => guards.allowUnload());
  return guards;
}, 1);

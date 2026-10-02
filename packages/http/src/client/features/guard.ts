/**
 * The navigation guard and confirmations (E64): unsaved changes a visit, Back/Forward or closing a layer would lose ask
 * first; closing the tab or reloading gets the browser's own question (`beforeunload`). A full load the server asks for (a
 * 409) is never stopped. Also the question itself — the app's dialog, or the browser's (`confirm`, `prompt`).
 */
import { accepted, type ConfirmHandler, type ConfirmRequest } from '../confirm.ts';
import type { NavigatorCore } from '../core.ts';
import { isHistoryState, type HistoryState } from '../history.ts';
import type { Layer } from '../layer.ts';

/**
 * Unsaved changes that a navigation would lose (E64) — `navigator.guard({ message })`: while it is registered (and `active()`
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

/** What the navigation guard asks by default. */
export const DEFAULT_LEAVE_MESSAGE = 'You have unsaved changes. Leave anyway?';

type GuardCore = Pick<NavigatorCore, 'window' | 'history' | 'key' | 'layers' | 'left' | 'started' | 'stack'>;

/** The guards of one navigator, and how it asks. */
export class Guards {
  readonly #core: GuardCore;
  readonly #ask: ConfirmHandler;
  /** Unsaved changes (E64): what a navigation asks about first. */
  readonly #guards = new Set<NavigationGuard>();
  /** The guard undid a Back/Forward (`history.go`): the popstate that brings the entry back is not a navigation. */
  #undoing: string | undefined;
  /** The user chose to leave: the popstate that redoes the Back/Forward passes the guards. */
  #redoing = false;
  /** The user chose to leave for another site (or a full load): the browser's own question does not ask again. */
  #unloadAllowed = false;

  constructor(core: GuardCore, ask: ConfirmHandler) {
    this.#core = core;
    this.#ask = ask;
  }

  /** Guards `guard` until the returned function lifts it — see `Navigator.guard`. */
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

  /** Whether a navigation that takes the levels `leaving` off the screen may go — asking, when a guard is on one. */
  async mayLeave(leaving: (level: number) => boolean, ignore?: true | readonly NavigationGuard[]): Promise<boolean> {
    if (ignore === true) return true;
    const blocking = this.blocking(leaving, ignore);
    if (blocking.length === 0) return true;
    return this.question({ kind: 'leave', message: blocking[0]!.message ?? DEFAULT_LEAVE_MESSAGE });
  }

  /** Asks the adapter; a failing dialog is a no. */
  async question(request: ConfirmRequest): Promise<boolean> {
    try {
      return accepted(request, await this.#ask(request));
    } catch {
      return false;
    }
  }

  /**
   * A popstate, before the navigator follows it: whether the guard takes it — the one that brings back the entry it undid,
   * or a Back/Forward it stops (unsaved changes on what it would take off the screen). `closing`: a layer closes by going
   * back — its close asked already.
   */
  popState(state: unknown, closing: boolean): boolean {
    // The guard undid a Back/Forward (E64): this brings the entry on screen back — nothing changes.
    if (this.#undoing !== undefined && isHistoryState(state) && state.key === this.#undoing) {
      this.#undoing = undefined;
      return true;
    }
    // Unsaved changes on what Back/Forward takes off the screen (E64): the browser moved already — so go back to where it
    // was, then ask; Leave does the Back/Forward again.
    if (!closing && !this.#redoing && isHistoryState(state) && this.#guards.size > 0 && this.#undo(state)) return true;
    this.#redoing = false;
    return false;
  }

  /**
   * Back/Forward to `state` would take guarded changes off the screen: undoes it (`history.go` the other way) and asks —
   * Leave goes again. Returns whether it stopped the popstate. An entry without a position (of an older client) cannot be
   * undone: it passes.
   */
  #undo(state: HistoryState): boolean {
    const { window, history, layers } = this.#core;
    const target = new Set<string>([state.key, ...(state.layer?.below ?? [])]);
    const blocking = this.blocking((level) => !target.has(level === 0 ? this.#core.key! : layers[level - 1]!.entry));
    const delta = typeof state.index === 'number' ? state.index - history.index : undefined;
    const go = window.history.go?.bind(window.history);
    if (blocking.length === 0 || delta === undefined || delta === 0 || !go) return false;
    this.#undoing = this.#core.stack.top();
    go(-delta);
    void this.question({ kind: 'leave', message: blocking[0]!.message ?? DEFAULT_LEAVE_MESSAGE }).then((leave) => {
      if (!leave || this.#core.left) return;
      this.#redoing = true;
      go(delta);
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

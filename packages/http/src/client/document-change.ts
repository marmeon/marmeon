/**
 * Full loads the server asks for: a `409` with `x-marmeon-location`. Signing in or out is a document change nothing
 * stops; a new build (`x-marmeon-reload: version`) is the one the client may postpone — the `version` event, or unsaved
 * changes the user keeps. Postponed, the user's next visit loads fully.
 */
import { LOCATION_HEADER, RELOAD_HEADER } from '../protocol.ts';
import type { NavigatorCore } from './core.ts';
import type { VersionChange } from './events.ts';
import type { NavigationGuard } from './features/guard.ts';
import { notify } from './notify.ts';
import { atOrigin, navigable } from './request.ts';

/** What a new build asks by default when loading it would lose unsaved changes. */
export const DEFAULT_NEW_VERSION_MESSAGE = 'A new version of this app is available. Load it now? Your unsaved changes will be lost.';

/** How the page loads fully: the URL of the 409 (`assign`, or `replace` the entry), or the page on screen again (`reload`). */
export type DocumentChangeHow = 'assign' | 'replace' | 'reload';

type DocumentChangeCore = Pick<NavigatorCore, 'window' | 'left' | 'leave' | 'emit' | 'fire' | 'blocking' | 'ask'>;

/** The full loads of one navigator, and the new build it postponed. */
export class DocumentChange {
  readonly #core: DocumentChangeCore;
  /**
   * A new build is out, and loading it was postponed (the `version` event prevented, or unsaved changes kept it): where to
   * load it. The next visit of the user loads its page fully; background requests stop asking.
   */
  #newVersion: string | undefined;
  readonly #listeners = new Set<() => void>();

  constructor(core: DocumentChangeCore) {
    this.#core = core;
  }

  /** Where a postponed new build loads — undefined while none is waiting. */
  get newVersion(): string | undefined {
    return this.#newVersion;
  }

  /** Follows {@link newVersion}. Returns the function that stops it. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }

  /** Loads the new build now — a full load of the page on screen (or where the postponed one was going). */
  reloadNow(): void {
    if (this.#core.left) return;
    this.#core.fire('unload');
    const location = this.#newVersion ?? this.#core.window.location.href;
    this.#core.leave();
    this.#core.window.location.assign(location);
  }

  /**
   * A `409` with `x-marmeon-location`: the page loads fully. Signing in or out (`x-marmeon-reload: history`, or any reason but
   * `version`) is a document change nothing stops — not the `version` event, not a navigation guard. A new build (`version`) is
   * the one the client may postpone: the `version` event can prevent it, and unsaved changes nobody agreed to leave (guards not
   * in `consented`) ask first. Postponed, the user's next visit loads fully. Resolves with whether the document is being left.
   */
  async change(response: Response, how: DocumentChangeHow, consented?: true | readonly NavigationGuard[]): Promise<boolean> {
    await response.body?.cancel();
    // Only http(s) loads — whatever the header holds. A change that cannot name a page to load (signing in or out) still ends
    // this document: the page on screen loads again. A new build waits for a page it can load.
    const target = navigable(atOrigin(response.headers.get(LOCATION_HEADER)!, this.#core.window), this.#core.window.location.href);
    if (!target) {
      if (response.headers.get(RELOAD_HEADER) === 'version') return false;
      how = 'reload';
    }
    const href = target?.href ?? '';
    const go = () => {
      if (this.#core.left) return;
      this.#core.fire('unload');
      this.#core.leave();
      if (how === 'reload') this.#core.window.location.reload();
      else if (how === 'replace') this.#core.window.location.replace(href);
      else this.#core.window.location.assign(href);
    };
    // Only the exact `version` reason may wait (RELOAD_HEADER) — anything else is signing in or out: the full load wins.
    if (response.headers.get(RELOAD_HEADER) !== 'version') {
      go();
      return true;
    }
    if (this.#core.left) return true;
    // Postponed already: no new question for every request that finds out again (a poll, an island).
    if (this.#newVersion !== undefined) return false;
    const unsaved = consented === true ? [] : this.#core.blocking(() => true, consented ?? []);
    let prevented = false;
    const event: VersionChange = {
      location: href,
      unsaved: unsaved.length > 0,
      preventDefault: () => void (prevented = true),
      get defaultPrevented() {
        return prevented;
      },
      reload: () => go(),
    };
    this.#core.emit('version', undefined, event);
    if (this.#core.left) return true;
    const stay = prevented || (unsaved.length > 0 && !(await this.#core.ask({ kind: 'leave', message: unsaved[0]!.message ?? DEFAULT_NEW_VERSION_MESSAGE })));
    if (this.#core.left) return true;
    if (stay) {
      this.#newVersion = href;
      notify(this.#listeners);
      return false;
    }
    go();
    return true;
  }
}

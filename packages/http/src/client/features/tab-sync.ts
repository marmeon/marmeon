/**
 * Tab sync (W8 step 8, E148, E149, E165 — closes E66) as a feature: the tabs of one browser tell each other when the session's
 * epoch changes (someone signed in or out, the session was regenerated, the language changed), and a tab that hears it lets go
 * of everything it keeps — the pages in memory, islands, pages fetched ahead, once props, remembered input — and loads again.
 * `createBespokeApp` attaches it by default (E149; `tabSync: false` leaves it out: the risk E66 is back).
 *
 * - **The channel carries a hint, never data:** `{ v: 1, epoch }` on a `BroadcastChannel` — the epoch is opaque (an HMAC on the
 *   server); no props, no ids, no tokens. A message of any other shape is ignored. A tab posts its epoch when it starts and when
 *   an answer brings a new one (its own sign-in by the remember-me cookie, say); the sender never hears its own message.
 * - **The server decides:** a tab that hears another epoch — or becomes visible again (`visibilitychange`: a hidden or frozen tab
 *   missed the message), or comes back from the back/forward cache (`pageshow`) — asks `GET /_bespoke/session`. Only an epoch
 *   that differs from its own there changes anything: a stale tab's message makes no tab reload.
 * - **Then:** the document is left (every slot of every feature emptied, requests aborted — the core's `leave`, as for a 409) and
 *   loaded again: the server says what it shows now (the login page, the new language). With unsaved changes on screen (a
 *   navigation guard holds) the page stays: pages fetched ahead are dropped, and the user is asked (when the tab is visible)
 *   whether to load it again — no, and the next answer of the server takes it over (then the entries of the old epoch go).
 * - **Back/Forward:** every history entry holds the epoch it was written under (`history.state.epoch`, a registered field — a
 *   position, never data, E36); Back or Forward to an entry of another epoch loads it from the server, never from memory.
 * - **Flash messages stay with their tab** (E165): every request names its document (`x-bespoke-document`), and the server
 *   binds a message to the document whose request flashed it — another tab's poll or visit never takes it.
 *
 * Its state is in a slot of the document (the channel, the epochs, the entries' keys): leaving the document empties it.
 */
import { DOCUMENT_HEADER, SESSION_PATH, TAB_SYNC_CHANNEL, type TabSyncMessage } from '../../tab-sync-protocol.ts';
import type { FeatureHost } from '../core.ts';
import { defineFeature, slot } from '../feature.ts';
import { isHistoryState, newKey, type HistoryState } from '../history.ts';
import { notify } from '../notify.ts';

/** What the user is asked when another tab changed the session and unsaved changes are on screen. */
export const DEFAULT_SESSION_CHANGED_MESSAGE = 'You signed in or out, or changed the language, in another tab. Load this page again? Your unsaved changes will be lost.';

/** Where a change of the epoch was noticed: an answer of this tab, another tab's message, the server asked (visible again, bfcache). */
export type EpochOrigin = 'self' | 'tab' | 'server';

/** The `epoch` event: the session's epoch changed. */
export interface EpochChange {
  readonly previous: string | undefined;
  readonly next: string;
  readonly origin: EpochOrigin;
}

/** What the feature offers (`navigator.use(tabSync)`, React: `useFeature(tabSync)`). */
export interface TabSync {
  /** The session's epoch as this tab knows it (opaque) — undefined before a page brought one. */
  readonly epoch: string | undefined;
  /** Listens to changes of the epoch (E132's hook API, as a feature) — before the tab lets go of what it keeps. Returns the function that stops it. */
  on(event: 'epoch', listener: (change: EpochChange) => void): () => void;
  /** Asks the server now — what becoming visible does. */
  check(): Promise<void>;
}

/** The document's state — emptied when it is left. */
interface TabSyncState {
  channel?: BroadcastChannel | undefined;
  /** The epoch of what is on screen (and what history entries are written under). */
  epoch?: string | undefined;
  /** The newest epoch the tab knows of — ahead of `epoch` while unsaved changes keep the page. */
  known?: string | undefined;
  /** The history entries written in this document — what is let go of when the epoch changes. */
  keys?: Set<string> | undefined;
  /** The user is still to be asked (the tab was hidden when it noticed). */
  asking?: boolean | undefined;
  /** A question to the server under way. */
  checking?: Promise<void> | undefined;
}

const STATE = slot<TabSyncState>(
  'tab-sync',
  () => ({}),
  (state) => {
    state.channel?.close();
    for (const key of Object.keys(state)) delete state[key as keyof TabSyncState];
  },
);

/** An epoch as the server writes it — base64url, short. Anything else is no epoch. */
const EPOCH = /^[\w-]{1,64}$/;

/** A message of the channel — exactly `{ v: 1, epoch }`, or nothing. */
export function isTabSyncMessage(data: unknown): data is TabSyncMessage {
  if (typeof data !== 'object' || data === null || Object.keys(data).length !== 2) return false;
  const { v, epoch } = data as Record<string, unknown>;
  return v === 1 && typeof epoch === 'string' && EPOCH.test(epoch);
}

/**
 * The tab-sync feature. Its hooks run after the guard's (order 9): a Back/Forward the guard stops never reaches it.
 */
export const tabSync = defineFeature(
  'tabSync',
  (host: FeatureHost): TabSync => {
    const { window: win, history } = host;
    const doc = win.document;
    const listeners = new Set<(change: EpochChange) => void>();
    const state = (): TabSyncState => host.document(STATE);
    // The document's id: every request names it, and a flash message stays with the document whose request flashed it.
    const id = newKey();
    const first = (host.initial ?? host.page)?.epoch;
    const init = state();
    init.epoch = init.known = first;

    // Every history entry holds the epoch it was written under (E36: a position — registered, checked as a string).
    history.field('epoch', (value) => typeof value === 'string' && EPOCH.test(value));
    for (const method of ['push', 'replace'] as const) {
      const write = history[method].bind(history);
      history[method] = (entry: HistoryState, url: string) => {
        const current = state();
        (current.keys ??= new Set()).add(entry.key);
        write(current.epoch === undefined ? entry : ({ ...entry, epoch: current.epoch } as HistoryState), url);
      };
    }

    const post = (): void => {
      const { channel, epoch } = state();
      if (channel && epoch !== undefined) channel.postMessage({ v: 1, epoch } satisfies TabSyncMessage);
    };

    /** The entries in memory that are not on screen — let go of (with what features keep of them), and every page fetched ahead. */
    const forgetHidden = (): void => {
      const shown = new Set([host.key, ...host.layers.map((layer) => layer.entry)]);
      for (const key of state().keys ?? []) if (!shown.has(key)) host.cache.delete(key);
      host.fire('write');
    };

    const reload = (): void => {
      if (host.left) return;
      host.fire('unload');
      host.leave();
      win.location.reload();
    };

    /** Asks the user whether to load the page again — once the tab is visible (a hidden tab's dialog would wait unseen). */
    const ask = (): void => {
      const current = state();
      if (doc?.visibilityState === 'hidden') return void (current.asking = true);
      current.asking = false;
      void host.ask({ kind: 'leave', reason: 'session', message: DEFAULT_SESSION_CHANGED_MESSAGE }).then((yes) => yes && reload());
    };

    const change = (next: string, origin: EpochOrigin): void => {
      const current = state();
      const previous = current.known;
      current.known = next;
      notify(listeners, { previous, next, origin });
      if (host.left) return;
      if (origin === 'self') {
        // An answer of this tab brought it (a sign-in by the remember-me cookie): what is on screen is new — the rest goes, and
        // the other tabs hear of it. The entry on screen was written under the old epoch: written again.
        current.epoch = next;
        forgetHidden();
        // A page of the newest session is on screen (also after the user kept one of an older): nothing waits for it any more.
        host.fire('stale', false);
        const entry: unknown = win.history.state;
        if (isHistoryState(entry)) history.replace(entry, win.location.href);
        post();
        return;
      }
      // Unsaved changes on screen: the page stays, the user decides — pages fetched ahead go (a click would show one), and Back or
      // Forward to an entry of the old epoch loads it from the server (`popState` below). Otherwise the document goes, and loads again.
      if (host.blocking(() => true).length === 0) return reload();
      host.fire('write');
      // What runs against the session in the background (the live stream) waits until a page of the new one lands (W9 step 4).
      host.fire('stale', true);
      ask();
    };

    /** What the server says — another epoch than the tab's changes it (`origin`: why it asked). Offline: nothing. */
    const check = (origin: EpochOrigin): Promise<void> => {
      const current = state();
      return (current.checking ??= (async () => {
        try {
          const response = await win.fetch(SESSION_PATH, { headers: { accept: 'application/json' }, cache: 'no-store' });
          const next: unknown = response.ok ? ((await response.json()) as { epoch?: unknown }).epoch : undefined;
          if (typeof next === 'string' && EPOCH.test(next) && next !== state().known && !host.left) change(next, origin);
        } catch {
          // Offline, or the server is away: the tab asks again when it becomes visible next.
        } finally {
          current.checking = undefined;
        }
      })());
    };

    // An answer of this tab with a new epoch: it changed the session itself (or a page of another session landed).
    host.navigator.subscribe((page) => {
      const current = state();
      const next = page.epoch;
      if (next === undefined || next === current.epoch || host.left) return;
      if (next === current.known) {
        // The server's answer after the user kept the page: now what is on screen is of the new epoch, too.
        current.epoch = next;
        forgetHidden();
        host.fire('stale', false);
      } else change(next, 'self');
    });

    // Back/Forward to an entry of another epoch: from the server, never from memory — the whole document, as it is now.
    host.on('popState', (entry) => {
      const epoch = isHistoryState(entry) ? (entry as { epoch?: unknown }).epoch : undefined;
      if (typeof epoch !== 'string' || epoch === state().known) return undefined;
      reload();
      return true;
    });

    // Every request names the document (E165): visits through `start`, actions and live validations through `send`.
    host.on('start', () => ({ headers: { [DOCUMENT_HEADER]: id } }));
    host.on('send', (headers) => void (headers[DOCUMENT_HEADER] = id));

    const onMessage = (event: MessageEvent): void => {
      if (isTabSyncMessage(event.data) && event.data.epoch !== state().known) void check('tab');
    };
    const onVisible = (): void => {
      if (!host.started || host.left || doc?.visibilityState === 'hidden') return;
      if (state().asking) ask();
      else void check('server');
    };
    const onPageShow = (event: Event): void => {
      if ((event as PageTransitionEvent).persisted && !host.left) void check('server');
    };
    host.on('started', () => {
      doc?.addEventListener?.('visibilitychange', onVisible);
      const Channel = win.BroadcastChannel;
      const current = state();
      if (Channel && !current.channel) {
        current.channel = new Channel(TAB_SYNC_CHANNEL);
        current.channel.addEventListener('message', onMessage);
      }
      win.addEventListener('pageshow', onPageShow);
      post();
    });
    host.on('stopped', () => {
      const current = state();
      current.channel?.close();
      current.channel = undefined;
      win.removeEventListener('pageshow', onPageShow);
      doc?.removeEventListener?.('visibilitychange', onVisible);
    });

    return {
      get epoch() {
        return state().known;
      },
      on: (_event, listener) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      check: () => check('server'),
    };
  },
  9,
);

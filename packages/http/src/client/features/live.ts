/**
 * Live props (W6.10, E89, E90, E104) as a feature — loaded by the core when a page, a layer or an island follows a channel
 * (`PageObject.live`), like the layers (E71): ONE `EventSource` per document for every channel on screen; a hint (`{ channel,
 * only, seq }`, never data) becomes a partial reload of what follows the channel, through its own route.
 *
 * - **Bursts become one reload per target** (the page, a layer, an island): hints are collected until 250 ms pass without one
 *   (at most 2 s after the first), then each target reloads once — the union of what its subscriptions name.
 * - **Unsaved changes** on screen (a guard holds): no reload — `updates.pending`, until the user applies them (`apply()`).
 * - **Not the tab that caused it**: every request of this document names it (`x-bespoke-connection`) — the server sends that
 *   tab the hint with nothing to reload.
 * - **Always connected** (E104), also in a hidden tab — except a page loaded over HTTP/1.1 (or an unknown protocol), where
 *   the browser allows six connections per host: then only while the tab is visible.
 * - **Catching up**: whenever the stream comes back (an error, a frozen tab, a hidden one over HTTP/1.1), `hello` says where each
 *   channel stands; one that moved since it was last seen (or was never seen on a stream that broke) reloads once.
 * - **In a slot of the document**: the stream, the sequences seen and the hints waiting — a 409 (signed out, a new build) closes
 *   the stream and forgets them (`#leave`).
 */
import { CONNECTION_HEADER, LIVE_PATH } from '../../live-protocol.ts';
import type { LiveHint, LiveSubscription } from '../../page.ts';
import { defineFeature, slot } from '../feature.ts';
import { notify } from '../notify.ts';

/** The quiet a burst of hints ends with — and the longest a hint waits for its reload (ms). */
export const LIVE_QUIET = 250;
export const LIVE_MAX_WAIT = 2_000;
/** How long a stream the server refused (or that broke for good) waits before it is tried again (ms). */
export const LIVE_RETRY_REFUSED = 30_000;

/** What the stream says when it opens. */
interface Hello {
  readonly seq: Readonly<Record<string, number>>;
  readonly missed?: readonly string[];
}

/** What follows channels on screen — and how it reloads. */
interface Target {
  readonly live: readonly LiveSubscription[] | undefined;
  reload(only: readonly string[] | undefined): unknown;
}

/** What the document keeps of its live stream — all of it emptied (and the stream closed) when the document is left. */
interface LiveState {
  /** The stream, while it is open (or reconnecting). */
  source?: EventSource | undefined;
  /** Its URL — the channels it follows, with their tokens. */
  url?: string | undefined;
  /** The server ended it (the session ended): not again until the channels change. */
  ended?: boolean | undefined;
  /** The last sequence seen of each channel. */
  seen?: Map<string, number> | undefined;
  /** Channels of a stream that broke before they were seen: whatever they say next is news. */
  away?: Set<string> | undefined;
  /** Hinted channels → the props the hints named (`true`: all). */
  hinted?: Map<string, Set<string> | true> | undefined;
  /** Channels to catch up on (what their subscriptions follow, all of it). */
  missed?: Set<string> | undefined;
  /** The burst's timer, and when its first hint came. */
  timer?: ReturnType<typeof setTimeout> | undefined;
  first?: number | undefined;
  /** Updates wait for unsaved changes (`updates.pending`). */
  pending?: boolean | undefined;
}

const LIVE = slot<LiveState>('live', () => ({}), (state) => {
  state.source?.close();
  clearTimeout(state.timer);
  for (const key of Object.keys(state) as (keyof LiveState)[]) state[key] = undefined;
});

/** Updates that wait because of unsaved changes (E104 — React: `useLiveUpdates()`). */
export interface LiveUpdates {
  /** Hints came while a form on screen had unsaved changes: their reloads wait. */
  readonly pending: boolean;
  /** Reloads what waits now — the unsaved changes on screen may be overwritten. */
  apply(): void;
  /** Follows `pending`. Returns the function that stops it. */
  subscribe(listener: () => void): () => void;
}

/** What adapters use of live props. */
export interface LiveFeature {
  /** Looks at what is on screen again and follows its channels — the core calls it when an answer follows some. */
  sync(): void;
  readonly updates: LiveUpdates;
  /** This document's id — what each of its requests names (`x-bespoke-connection`). */
  readonly connection: string;
}

export const live = defineFeature('live', (host): LiveFeature => {
  const win = host.window;
  const doc = win.document;
  // Not crypto.randomUUID(): that needs a secure context (a page over plain HTTP on another host than localhost has none).
  const connection = Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const state = () => host.document(LIVE);
  const listeners = new Set<() => void>();
  // E104: over HTTP/1.1 (six connections per host) — or an unknown protocol — a stream only while the tab is visible.
  const protocol = (win.performance?.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.nextHopProtocol ?? '';
  const h1 = !/^h[23]/.test(protocol);
  let syncing: ReturnType<typeof setTimeout> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;

  /** What follows channels on screen: the page, the layers over it, the islands of each. */
  const targets = (): Target[] => {
    const all: Target[] = [{ live: host.page.live, reload: (only) => host.navigator.reload({ only, async: true }) }];
    const owners = [host.owner];
    for (const layer of host.layers) {
      all.push({ live: layer.page.live, reload: (only) => layer.reload({ only, async: true }) });
      owners.push(layer.owner);
    }
    for (const owner of owners) {
      for (const region of owner.live.values()) all.push({ live: region.snapshot.region?.live, reload: (only) => region.reload(only ? { only } : {}) });
    }
    return all;
  };

  /** Where a stream that went away stands: its channels are news once it is back. */
  const away = (current: LiveState) => {
    current.away ??= new Set();
    for (const channel of new URLSearchParams(current.url?.split('?')[1]).getAll('c')) current.away.add(channel.slice(channel.indexOf('.') + 1));
  };

  const close = (current: LiveState) => {
    current.source?.close();
    current.source = undefined;
    away(current);
  };

  const sync = () => {
    syncing = undefined;
    if (host.left || !win.EventSource) return;
    const current = state();
    const channels = new Map<string, string>();
    for (const target of targets()) for (const { channel, token } of target.live ?? []) channels.set(channel, token);
    const query = new URLSearchParams({ connection });
    for (const channel of [...channels.keys()].sort()) query.append('c', `${channels.get(channel)}.${channel}`);
    const url = channels.size > 0 ? `${LIVE_PATH}?${query}` : undefined;
    const hidden = h1 && doc?.visibilityState === 'hidden';
    // The same channels, open (or reconnecting by itself) — or ended by the server: nothing to do.
    if (url === current.url && !hidden && (current.ended || current.source)) return;
    if (url !== current.url) current.ended = undefined;
    // Another set of channels (or the stream comes back): the old stream goes. A switch is no gap — a channel the new stream
    // follows too was seen there (its `hello` compares); one never seen yet starts with what its page brought.
    current.source?.close();
    current.source = undefined;
    current.url = url;
    if (!url || hidden || current.ended) return;
    const source = new win.EventSource(url);
    current.source = source;
    const mine = () => !host.left && state().source === source;
    source.addEventListener('hello', (event) => {
      if (!mine()) return;
      const { seq, missed = [] } = JSON.parse((event as MessageEvent<string>).data) as Hello;
      const now = state();
      const seen = (now.seen ??= new Map());
      const behind = new Set(missed);
      for (const [channel, value] of Object.entries(seq)) {
        const last = seen.get(channel);
        if (last === undefined ? now.away?.has(channel) : last !== value) behind.add(channel);
        seen.set(channel, value);
      }
      now.away = undefined;
      if (behind.size === 0) return;
      now.missed ??= new Set();
      for (const channel of behind) now.missed.add(channel);
      burst();
    });
    source.addEventListener('refresh', (event) => {
      if (!mine()) return;
      const hint = JSON.parse((event as MessageEvent<string>).data) as LiveHint;
      const now = state();
      (now.seen ??= new Map()).set(hint.channel, hint.seq);
      // Caused by this tab: it shows the change already.
      if (hint.only?.length === 0) return;
      const hinted = (now.hinted ??= new Map());
      const props = hinted.get(hint.channel);
      if (hint.only === null || props === true) hinted.set(hint.channel, true);
      else hinted.set(hint.channel, new Set([...(props ?? []), ...hint.only]));
      burst();
    });
    // The session ended (signed out elsewhere): not again — the next page this tab gets is the server's answer to that.
    source.addEventListener('end', () => {
      if (!mine()) return;
      const now = state();
      now.source?.close();
      now.source = undefined;
      now.ended = true;
    });
    source.addEventListener('error', () => {
      if (!mine()) return;
      const now = state();
      // Broken: hints may pass meanwhile. The browser reconnects (`retry:`) — or, refused (403, 503), it gave up: later again.
      away(now);
      if (source.readyState !== 2) return;
      now.source = undefined;
      clearTimeout(retry);
      retry = setTimeout(sync, LIVE_RETRY_REFUSED);
    });
  };

  const schedule = () => {
    clearTimeout(syncing);
    syncing = setTimeout(sync, 10);
  };

  /** A hint came (or a catch-up): the reloads go when the burst is over — 250 ms quiet, at most 2 s after its first. */
  const burst = () => {
    const now = state();
    const at = Date.now();
    now.first ??= at;
    clearTimeout(now.timer);
    now.timer = setTimeout(() => flush(false), Math.max(0, Math.min(LIVE_QUIET, now.first + LIVE_MAX_WAIT - at)));
  };

  /** One reload per target: the union of what its subscriptions name of the hinted channels (all they follow when caught up). */
  const flush = (force: boolean) => {
    const now = state();
    clearTimeout(now.timer);
    now.timer = now.first = undefined;
    if (host.left || (!now.hinted?.size && !now.missed?.size)) return;
    // Unsaved changes on screen: the reloads wait for the user.
    if (!force && host.navigator.isGuarded()) {
      if (!now.pending) {
        now.pending = true;
        notify(listeners);
      }
      return;
    }
    const hinted = now.hinted ?? new Map<string, Set<string> | true>();
    const missed = now.missed ?? new Set<string>();
    for (const target of targets()) {
      let only: Set<string> | true | undefined;
      for (const subscription of target.live ?? []) {
        const props = hinted.get(subscription.channel);
        if (!props && !missed.has(subscription.channel)) continue;
        const named = !props || props === true || missed.has(subscription.channel) ? (subscription.only ?? true) : subscription.only ? subscription.only.filter((prop) => props.has(prop)) : props;
        if (named === true || only === true) only = true;
        else only = new Set([...(only ?? []), ...named]);
      }
      if (only === true) target.reload(undefined);
      else if (only?.size) target.reload([...only]);
    }
    now.hinted = now.missed = undefined;
    if (now.pending) {
      now.pending = undefined;
      notify(listeners);
    }
  };

  // Every request of this document names it — so the server leaves it out of the hints its writes cause.
  host.on('start', () => ({ headers: { [CONNECTION_HEADER]: connection } }));
  host.on('send', (headers) => void (headers[CONNECTION_HEADER] = connection));
  // What is on screen changed: follow its channels (one stream — the old channels go, the new come).
  host.navigator.subscribe(schedule);
  host.on('draw', () => {
    schedule();
    // The unsaved changes may be gone (a layer closed): what waited reloads now.
    if (state().pending) burst();
  });
  // Another page took the screen: what waited for the one before is no longer wanted.
  host.on('page', () => {
    const now = state();
    clearTimeout(now.timer);
    now.timer = now.first = now.hinted = now.missed = undefined;
    if (now.pending) {
      now.pending = undefined;
      notify(listeners);
    }
  });
  // Visible again (E104), back from a frozen state, or from the back/forward cache: connect — `hello` says what was missed.
  const back = () => {
    if (h1 && doc?.visibilityState === 'hidden') return void (state().source && close(state()));
    sync();
  };
  doc?.addEventListener?.('visibilitychange', back);
  doc?.addEventListener?.('resume', back);
  win.addEventListener('pageshow', back);
  schedule();

  return {
    sync: schedule,
    connection,
    updates: {
      get pending() {
        return state().pending === true;
      },
      apply: () => flush(true),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    },
  };
});

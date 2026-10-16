/**
 * The page protocol on the wire — stable; its version is the value of `x-marmeon`. The headers, the page and region objects
 * the server answers with and the checks that read them. Importable in the browser as `@marmeon/http/protocol`, so it must
 * stay free of server code.
 */
import type { FlashMessage } from './page.ts';
import type { ViewProps } from './view.ts';

/**
 * With an action's answer: the flash messages it delivers — JSON, URI-encoded (header values are ASCII). An action
 * is shown to the user (`useAction`), so it takes the messages its controller flashed instead of leaving them for later.
 */
export const FLASH_HEADER = 'x-marmeon-flash';

/**
 * With a prefetch's answer: flash messages wait for the page the user is shown — the prefetch took none. The client does
 * not show that prefetched page then: the visit asks the server, whose answer delivers them (the toast is not lost).
 */
export const FLASH_WAITING_HEADER = 'x-marmeon-flash-waiting';

/** The wire format of a page — shared by the server and every UI adapter. */
export interface PageObject {
  component: string;
  props: ViewProps;
  url: string;
  /** Build version of the assets (null in development). A client with another version reloads fully. */
  version?: string | null;
  /**
   * The language of the page (the request's locale, from @marmeon/i18n) — one of the app's supported locales.
   * The browser loads only this locale's messages (`virtual:marmeon/lang`), never the messages themselves from here.
   */
  locale?: string;
  /**
   * Where messages missing in `locale` come from (`APP_FALLBACK_LOCALE`) — sent with `locale`, so the browser's language
   * files fall back the way the server's do, configured once.
   */
  fallbackLocale?: string;
  /**
   * Props the response left out to load next (`defer()`), by group: the client fetches each group with a partial
   * reload right after showing the page. Only in full responses.
   */
  deferredProps?: Record<string, string[]>;
  /** Props a partial reload merges into the client's (`merge()`): arrays appended, objects merged one level deep. */
  mergeProps?: string[];
  /** Props a partial reload merges all the way down (`deepMerge()`). */
  deepMergeProps?: string[];
  /**
   * Where merged arrays identify their items (`matchOn()`): `<prop>.<key>` or `<prop>.<path>.<key>` — an item with a
   * key already shown replaces it instead of appearing twice.
   */
  matchPropsOn?: string[];
  /**
   * The page's query, parsed by its request's `query` schema — only the fields the URL set validly, without
   * defaults (the canonical query). The browser never parses a URL itself: `useQueryState` reads this. Absent for a
   * route without a query schema.
   */
  query?: Record<string, unknown>;
  /** What an empty query parses to (the schema's defaults) — left out of the URLs the browser builds for this page. */
  queryDefaults?: Record<string, unknown>;
  /**
   * Deferred groups the server streams with this document — computed while the page streams and sent in it, so the
   * browser does not ask for them again. Only on a server-rendered document's page object.
   */
  streamedProps?: string[];
  /**
   * The page object is a layer's: the view of a route whose controller answered `this.view(…).layer({ base })` — shown
   * over the page (or the layers) on screen, with a history entry of its own. Absent for pages.
   */
  layer?: LayerInfo;
  /**
   * The layers over this page, bottom first — only on a server-rendered document's page object, for a deep link (or a reload)
   * of a layer's URL: this page is the layer's declared base (resolved in-process), or the neutral surface (the view
   * `layers/Backdrop`) when the base turned the user away. Never in a client-side navigation's answer.
   */
  layers?: PageObject[];
  /**
   * The flash messages this response delivers — a protocol field, not a prop: sent once, only with an answer that is shown
   * (never a prefetch or an island). The client core fires each once and keeps none of them, never in `history.state`.
   */
  flash?: FlashMessage[];
  /**
   * The name of the route that answered — what `<Link activeMatch="user-profile.*">` compares against. Only for a named
   * route the browser may know (never an `.internal()` one), and only on its own answer (an error page names none).
   */
  route?: string;
  /**
   * The page's once props (`once()`), by prop name: under which `key` the browser keeps the value, and until when
   * (`expiresAt`, ms since the epoch, by the server's clock). A prop listed here but missing from `props` is one the browser
   * said it holds ({@link ONCE_HEADER}) — the client core puts its value back in before anything renders.
   */
  onceProps?: Record<string, OnceInfo>;
  /**
   * Who the once props are for — opaque, new with every sign-in and sign-out. The server skips a held value only under the
   * same scope: another tab may have signed someone else in (the cookie changed, the memory did not).
   */
  onceScope?: string;
  /**
   * The CSRF token of the page's session — for forms that must work without JavaScript (`<Form>` renders it as `_token`).
   * Client-side requests send the `XSRF-TOKEN` cookie's copy instead. Absent without a session.
   */
  csrf?: string;
  /**
   * The session's epoch for tab sync — opaque, new whenever someone signs in or out, the session is regenerated or the
   * language changes (see `tab-sync-protocol.ts`). Absent without the http provider's `SessionEpoch`, and in a region object.
   */
  epoch?: string;
  /**
   * The live subscriptions of this page (or island, or layer): what its controller declared (`.live('users.7', { only })`)
   * and what every page shares (`shared.live(…)`), each channel signed for this session. See `live-protocol.ts`.
   */
  live?: LiveSubscription[];
}

/** A channel a page (island, layer) follows — `PageObject.live`. */
export interface LiveSubscription {
  /** The channel's name: `users.7`, `dashboard.sign-ins`. */
  readonly channel: string;
  /** The props a hint on the channel reloads (those of them the hint names) — absent: every prop the hint names, or all. */
  readonly only?: readonly string[];
  /**
   * The channel signed for the session the page was rendered for (an HMAC over the channel and a hash of the session
   * id) — the stream accepts only this. Whoever may see the page may hear its hints; signing in or out voids it.
   */
  readonly token: string;
}

/**
 * A hint on a live stream: a channel changed — reload `only` of what follows it. Never data: whatever a reload
 * brings goes through the page's own route (its middleware, policies and props). `only: null` — the props each
 * subscription names (or all); `only: []` — nothing (the request that caused it came from this tab). `seq` counts the
 * channel's hints, so a stream that was away knows whether it missed one.
 */
export interface LiveHint {
  readonly channel: string;
  readonly only: readonly string[] | null;
  readonly seq: number;
}

/** Where the browser keeps a once prop. */
export interface OnceInfo {
  /** The key it is kept under — the prop's name for a shared prop, `<view>:<prop>` for a page's own, or `once(fn, { key })`. */
  readonly key: string;
  /** Kept until then (ms since the epoch) — sent again after it; absent: for the life of the document. */
  readonly expiresAt?: number;
}

/**
 * The once props the browser holds: their keys, comma-separated — the server does not compute them again (they stay in
 * `onceProps`, without a value). Sent with every page request of the client core, with {@link ONCE_SCOPE_HEADER}.
 */
export const ONCE_HEADER = 'x-marmeon-once';

/** The scope the held once props were sent under (`PageObject.onceScope`) — the server skips them only for the same scope. */
export const ONCE_SCOPE_HEADER = 'x-marmeon-once-scope';

/**
 * Why a `409` with {@link LOCATION_HEADER} reloads the page: `version` — a new build, which the client may postpone; anything
 * else (`history`: signing in or out, or no header at all) is a document change nothing can stop. Only the exact value `version` is
 * cancelable; `ClearClientHistory` overwrites it on every 409 it makes.
 */
export const RELOAD_HEADER = 'x-marmeon-reload';

/** What a layer's page object says about it. */
export interface LayerInfo {
  /**
   * Its identity in a stack: an answer of the layer with the same key replaces it in place (a form that failed validation,
   * the next step of a wizard) — another key stacks on top. Default: the view's name.
   */
  readonly key: string;
  /** The URL of its declared base — the page a deep link or a reload shows under it. */
  readonly base: string;
  /**
   * The answer of an action (a POST, …), not of a GET: shown once — when it leaves the screen it is gone from memory (its URL
   * asked again with GET is something else), and what is beneath it is reloaded (the action changed it). A new API token's
   * plain text, say.
   */
  readonly once?: true;
}

/** How deep layers stack: an answer that would open an eleventh is shown as a page instead. */
export const MAX_LAYER_DEPTH = 10;

/**
 * The answer of `closeLayer()` to a layer's request: JSON {@link LayerClose} — the client closes that many layers and
 * reloads what is beneath them. (Without a layer — no JavaScript — the same result is a redirect.)
 */
export const LAYER_CLOSE_HEADER = 'x-marmeon-layer-close';

/** What the server tells a layer's client to do instead of showing a page: close (the JSON body of {@link LAYER_CLOSE_HEADER}'s answer). */
export interface LayerClose {
  /** How many layers close, from the one that asked down (default 1). */
  readonly layers: number;
  /** Then reload what is beneath them — the page and the layers that stay: some props (a partial reload of each), or `true` all. */
  readonly reload?: readonly string[] | true;
}

/** Client-side navigations send this header and receive the page object as JSON. */
export const PAGE_HEADER = 'x-marmeon';

/**
 * Sent with an action (`useAction`): a request that does not navigate — answered with data (`this.json(…)`), never with
 * a page. Its redirect is not followed: the server answers `204` with {@link ACTION_REDIRECT_HEADER} instead. Its answer
 * is never cached (`Cache-Control: no-store`): it is about who asked, at that moment.
 */
export const ACTION_HEADER = 'x-marmeon-action';

/** With an action's `204`: where its controller redirected to — the client says so (`{ kind: 'redirect' }`), it does not go there. */
export const ACTION_REDIRECT_HEADER = 'x-marmeon-redirect';

/** Whether `request` is an action's (`x-marmeon-action`). */
export function isActionRequest(request: Request): boolean {
  return request.headers.get(ACTION_HEADER) === 'true';
}

/**
 * A live validation (`useForm(…, { validate })`): the route's own request — same method, URL and body — naming the fields
 * to check (`name,email`). The server runs the route's middleware, `authorize` and request schema, never its controller, and
 * answers `204` (valid) or `422` with the errors of those fields only. Read-only and never cached. (The same name as the
 * router's `VALIDATE_HEADER` — this module may not import it.)
 */
export const VALIDATE_HEADER = 'x-marmeon-validate';

/** On a live validation's `204` and `422`: the fields it checked — so a client tells its answer from a proxy's. */
export const VALIDATED_HEADER = 'x-marmeon-validated';

/**
 * Uploads go in three steps: the client asks the form's route for an upload target — the route's own method and
 * URL, naming the field (`avatar`), with the file's name, size and type as JSON. The server runs the route's middleware and
 * `authorize`, reads the field's `upload()` rule and answers `{ token, upload: { method, url, fields?, headers? } }`; the file
 * goes there (with progress), and the form sends the token in the field — never the file. The receiving request carries the
 * header too (with the token's id). Read-only like a live validation: no session write, no cookie.
 */
export { UPLOAD_HEADER } from './upload-header.ts';

/** The asset version the client was built with; a mismatch answers 409. */
export const VERSION_HEADER = 'x-marmeon-version';

/**
 * With a 409: where the client loads fully — after a deployment (asset version)
 * and after signing in or out (`ClientHistory`), so no page kept in memory outlives either.
 */
export const LOCATION_HEADER = 'x-marmeon-location';

/**
 * A partial reload: the component the client shows. The server answers with only
 * some props when it renders this component — and with all of them for any other.
 */
export const PARTIAL_COMPONENT_HEADER = 'x-marmeon-partial-component';

/** With a partial reload: the props to send, comma-separated (`only`). `always()` props come anyway. */
export const PARTIAL_DATA_HEADER = 'x-marmeon-partial-data';

/** With a partial reload: the props to leave out, comma-separated (`except`). */
export const PARTIAL_EXCEPT_HEADER = 'x-marmeon-partial-except';

/**
 * Sent with a prefetch (`<Link prefetch>`, `router.prefetch()`) — `Purpose: prefetch`, as browsers do for their own
 * prefetches (`Sec-Purpose`, which scripts may not set). The user has not asked for the page yet: a GET that does
 * something besides showing (marks notifications read, remembers where a guest wanted to go) skips that for a
 * prefetch — see {@link isPrefetch}.
 */
export const PURPOSE_HEADER = 'purpose';

/**
 * Whether `request` is a prefetch — ours (`Purpose: prefetch`) or the browser's (`Sec-Purpose: prefetch`). Answer it
 * like the real request, minus side effects: the client shows the prefetched page when the link is clicked (within
 * its `cacheFor`), without asking again. A page whose visit must do something should not be prefetched.
 */
export function isPrefetch(request: Request): boolean {
  const purpose = `${request.headers.get(PURPOSE_HEADER) ?? ''},${request.headers.get('sec-purpose') ?? ''}`;
  return /(^|[\s,;])prefetch($|[\s,;])/i.test(purpose);
}

/**
 * Sent with the request of a region — `island` for an `<Island route>`: the server answers with the island's region object,
 * never with a page. A request without it never gets an island (a direct hit, a prefetch or a visit is a 404). Also in
 * `Vary` of the island's JSON.
 */
export const REGION_HEADER = 'x-marmeon-region';

/**
 * The kinds of region a request may ask for: `island` — an `<Island route>`; `layer` — a layer's request (opening it, or a visit
 * or a form inside it): a layer route answers with its page object (`layer`), a page route with its page as usual.
 */
export type RegionKind = 'island' | 'layer';

/**
 * How a region request ended when it brought no region object — the server answers `204` with this header instead of
 * following a redirect, a 401 or a 403 of the island route (they become the island's fallback, never a navigation
 * of the page). Failures (4xx, 5xx) keep their status and say `exception`.
 */
export const REGION_STATUS_HEADER = 'x-marmeon-region-status';

/** What a region request can end in besides its region object (see {@link REGION_STATUS_HEADER}). */
export type RegionOutcomeStatus = 'unauthorized' | 'forbidden' | 'exception';

/** The region `request` asks for (`x-marmeon-region`, with `x-marmeon`), or undefined for any other request. */
export function regionOf(request: Request): RegionKind | undefined {
  const { headers } = request;
  if (headers.get(PAGE_HEADER) !== 'true') return undefined;
  const region = headers.get(REGION_HEADER);
  return region === 'island' || region === 'layer' ? region : undefined;
}

/**
 * The wire format of a region (an island): the page object of the route it shows — its component, props, URL and query,
 * deferred and merged props — without the page's language (`locale`, `fallbackLocale`): it renders in the page's.
 */
export type RegionObject = Omit<PageObject, 'locale' | 'fallbackLocale' | 'streamedProps' | 'layer' | 'layers' | 'flash'>;

/** Id of the `<script type="application/json">` that carries the initial page. */
export const PAGE_SCRIPT_ID = 'marmeon-page';

export function isPageObject(value: unknown): value is PageObject {
  return typeof value === 'object' && value !== null && 'component' in value && 'props' in value && 'url' in value;
}

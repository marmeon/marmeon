/**
 * `@bespokecore/http/client` — the UI-free client core (E39). Everything a UI adapter needs that is not rendering:
 * visits and their events, 409/hard page changes, XSRF, the history and the in-memory page cache (E36), partial
 * reloads, deferred and merged props, prefetching, polling, scroll restoration, the progress bar, the first page,
 * route URLs and the page's messages. It may use DOM APIs, but no UI framework — and it never imports server code
 * (only `../page.ts`, the shared page contract). The adapter contract is in this package's README.
 */
export {
  DEFAULT_PAGE_CACHE_SIZE,
  DEFAULT_PREFETCH_CACHE_FOR,
  isHistoryState,
  mergePage,
  Navigator,
  SCROLL_REGION_ATTRIBUTE,
  xsrfToken,
} from './navigation.ts';
export type {
  HistoryState,
  NavigatorOptions,
  NavigatorWindow,
  PrefetchOptions,
  ScrollPosition,
  ScrollRegion,
  Visit,
  VisitCallbacks,
  VisitEvent,
  VisitEvents,
  VisitException,
  VisitMethod,
  VisitOptions,
  VisitProgress,
} from './navigation.ts';
export { DEFAULT_PROGRESS_DELAY, PROGRESS_ATTRIBUTE, showProgress } from './progress.ts';
export type { ProgressOptions } from './progress.ts';
export { createPoll } from './poll.ts';
export type { Poll, PollDocument, PollOptions } from './poll.ts';
export { hasServerMarkup, isDevelopment, readInitialPage, rootElement } from './document.ts';
export { loadPageMessages, pageLocale } from './messages.ts';
export type { PageMessages } from './messages.ts';
export { resolveRoute } from './routes.ts';
export { HOVER_PREFETCH_DELAY, prefetchTriggers, prefetchUrlOf, visitUrlOf } from './links.ts';
export type { LinkClick, PrefetchSetting, PrefetchTrigger } from './links.ts';
export { firstErrors } from './forms.ts';
export { defaultTitle, TitleRegistry } from './title.ts';
export type { TitleTemplate } from './title.ts';
export { assertQueryPage, linkQuery, pageQuery, QueryState, queryUrl, withoutDefaults } from './query-state.ts';
export type { QueryStateOptions, QueryUpdate } from './query-state.ts';

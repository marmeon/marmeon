/**
 * `@bespokecore/http/client` — the UI-free client core (E39). Everything a UI adapter needs that is not rendering:
 * visits and their events, 409/hard page changes, XSRF, the history and the in-memory page cache (E36), regions
 * (islands, E50) and layers (E53) with their own requests and memory, partial reloads, deferred and merged props, prefetching, polling,
 * scroll restoration, the progress bar, the first page, route URLs and the page's messages. It may use DOM APIs, but no UI framework — and it never imports server code
 * (only `../page.ts`, the shared page contract). The adapter contract is in this package's README.
 */
export {
  DEFAULT_LEAVE_MESSAGE,
  DEFAULT_NEW_VERSION_MESSAGE,
  DEFAULT_PAGE_CACHE_SIZE,
  isHistoryState,
  mergePage,
  Navigator,
  SCROLL_REGION_ATTRIBUTE,
  xsrfToken,
} from './navigation.ts';
export type {
  HistoryState,
  InstantVisit,
  NavigationGuard,
  NavigatorOptions,
  NavigatorWindow,
  PrefetchOptions,
  RenderOptions,
  RevalidateOnBack,
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
  VersionChange,
} from './navigation.ts';
export { optimistic, PagePatches } from './features/optimistic.ts';
export { Actions, Submissions } from './action.ts';
export { actions } from './features/actions.ts';
export type { ActionsFeature } from './features/actions.ts';
export { defineFeature, slot } from './feature.ts';
export type { EntryStack, Feature, FeatureHook, FeatureHooks, FeatureHost, PendingVisit, Slot, VisitPart } from './feature.ts';
export type { PositionCheck } from './history.ts';
export { OnceStore } from './once.ts';
export { isSensitiveRememberField, NEVER_REMEMBERED_FIELD, REMEMBERED, Remembered, rememberable, SENSITIVE_REMEMBER_FIELD } from './remember.ts';
export { remember } from './features/remember.ts';
export type { RememberFeature } from './features/remember.ts';
export { markBusy } from './busy.ts';
export { DEFAULT_PROGRESS_DELAY, PROGRESS_ATTRIBUTE, progressBar, showProgress } from './progress.ts';
export { accepted, confirmRequest, nativeConfirm } from './confirm.ts';
export type { Confirm, ConfirmAnswer, ConfirmHandler, ConfirmOptions, ConfirmRequest, NativeDialogs } from './confirm.ts';
export { FlashChannel, flashOfResponse, takeFlash } from './flash.ts';
export type { FlashListener } from './flash.ts';
export type { ProgressIndicator, ProgressOptions } from './progress.ts';
export { createPoll } from './poll.ts';
export type { Poll, PollDocument, PollOptions } from './poll.ts';
export { hasServerMarkup, isDevelopment, readInitialPage, rootElement } from './document.ts';
export { loadPageMessages, pageLocale } from './messages.ts';
export type { PageMessages } from './messages.ts';
export { resolveRoute } from './routes.ts';
export { DEFAULT_PREFETCH_CACHE_FOR, HOVER_PREFETCH_DELAY, isCurrentLink, matchesRouteName, prefetchTriggers, prefetchUrlOf, visitUrlOf } from './links.ts';
export type { LinkClick, PrefetchSetting, PrefetchTrigger } from './links.ts';
export { defaultFormEntries, dirtyPaths, fieldPath, firstErrors, FORM_METHOD_FIELD, FORM_TOKEN_FIELD, formEntries, formObject, isDirtyPath, restoreFormEntries, sameEntries } from './forms.ts';
export type { FormEntries } from './forms.ts';
export { defaultTitle, TitleRegistry } from './title.ts';
export type { TitleTemplate } from './title.ts';
export { ownedRegion, Region, regionId, regionInitial } from './region.ts';
export { RegionOwner, REGIONS } from './owner.ts';
export type { LiveRegion } from './owner.ts';
export { islands } from './features/islands.ts';
export type { IslandsFeature } from './features/islands.ts';
export { Layer, MAX_LAYER_DEPTH } from './layer.ts';
export { layers, LayerStack } from './features/layers.ts';
export type { LayerCloseOptions, LayerControl, LayerHost } from './layer.ts';
export type { KeptRegion, RegionInitial, RegionFailure, RegionReloadOptions, RegionResponse, RegionSnapshot, RegionStatus, RegionTransport } from './region.ts';
export { assertQueryPage, linkQuery, pageQuery, QueryState, queryUrl, withoutDefaults } from './query-state.ts';
export { queryState } from './features/query-state.ts';
export type { QueryStateFeature } from './features/query-state.ts';
export type { QueryStateOptions, QueryUpdate } from './query-state.ts';
export type { ActionException, ActionHost, ActionMethod, ActionOptions, ActionOutcome, Submission } from './action.ts';
export { PatchQueue, Revalidations } from './optimistic.ts';
export { applyPatches, rollBack } from './patches.ts';
export { DEFAULT_LIVE_VALIDATION_DEBOUNCE, isSensitiveField, LiveValidation, liveValidationData, SENSITIVE_FIELD, sendLiveValidation } from './live-validation.ts';
export { liveValidation } from './features/live-validation.ts';
export type { LiveValidationFeature } from './features/live-validation.ts';
export { prefetch, Prefetches } from './features/prefetch.ts';
export { BackRevalidation, revalidateOnBack } from './features/revalidate-on-back.ts';
export { instant, InstantVisits } from './features/instant.ts';
export { guard, Guards } from './features/guard.ts';
export { liveValidationOnFirstUse, loadInstant, loadLayers, loadLiveValidation, loadPrefetch, prefetchWith } from './lazy.ts';
export type { FormLiveValidation } from './lazy.ts';
export type { LiveValidationOptions, LiveValidationOutcome, LiveValidationRequest, LiveValidationTrigger } from './live-validation.ts';
export type { OptimisticUpdate, PatchTarget, PropsPatch, Reloading, ReloadSpec } from './optimistic.ts';
export type { DeclaredOnBack } from './region.ts';

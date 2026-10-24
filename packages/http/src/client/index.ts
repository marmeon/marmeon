/**
 * `@marmeon/http/client` — the app's side of the UI-free client core: the handles `useFeature()` takes (`hooks`, `tabSync`),
 * `xsrfToken`, polling, the progress bar and the types an adapter re-exports to its app. It may use DOM APIs, but no UI
 * framework — and it never imports server code (only `../page.ts` and `../protocol.ts`, the shared page contract and protocol).
 * What a UI adapter builds on, the navigator and the features it attaches, is in `@marmeon/http/client/adapter`; the contract is
 * in CONTRIBUTING.md, "The client core and its adapters".
 */
export { hooksHandle as hooks } from './features/hooks.ts';
export { tabSyncHandle as tabSync } from './features/tab-sync.ts';
export type { FeatureHandle } from './handle.ts';
export { xsrfToken } from './navigation.ts';
export { createPoll } from './poll.ts';
export { progressBar } from './progress.ts';
export { accepted } from './confirm.ts';
export { isDevelopment } from './document.ts';
export { resolveRoute } from './routes.ts';
export { isSensitiveRememberField, NEVER_REMEMBERED_FIELD, SENSITIVE_REMEMBER_FIELD } from './remember.ts';
export type { Confirm, ConfirmAnswer, ConfirmOptions, ConfirmRequest } from './confirm.ts';
export type { ProgressIndicator, ProgressOptions, ProgressSource } from './progress.ts';
export type { Poll, PollOptions, PollDocument } from './poll.ts';
export type { PrefetchOptions, ViewTransitionOption, Visit, VisitCallbacks, VisitError, VisitEvent, VisitEvents, VisitMethod, VisitOptions, VisitProgress, InstantVisit, VersionChange } from './navigation.ts';
export type { PrefetchTrigger } from './links.ts';
export type { TitleTemplate } from './title.ts';
export type { LayerCloseOptions } from './layer.ts';
export type { RegionFailure, RegionStatus } from './region.ts';
export type { ActionError, ActionMethod, ActionOptions, ActionOutcome } from './action.ts';
export type { OptimisticUpdate, Reloading, PropsPatch, PatchTarget, ReloadSpec } from './optimistic.ts';
export type { QueryStateOptions, QueryUpdate } from './query-state.ts';
export type { SelectionKey } from './features/selection.ts';
export type { LooksLikePassword, LooksSensitive } from '../sensitive-fields.ts';
export type { ClientHooks, HookEvents, BeforeVisit, InvalidAnswer } from './features/hooks.ts';
export type { TabSync, EpochChange, EpochOrigin } from './features/tab-sync.ts';
export type { IgnoredGuard } from './features/guard.ts';

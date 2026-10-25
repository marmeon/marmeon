/**
 * `@marmeon/react` — the React rendering layer on the UI-free client core `@marmeon/http/client`:
 * components, hooks, context, layouts, error boundaries and `<Head>`. Visits, history, caching, prefetching, polling
 * and the progress bar come from the core (import `Navigator`, `createPoll` … from there).
 */
export { useFeature, usePage, useRouter } from './app.tsx';
// The progress bar (opt-in): `createMarmeonApp({ progress: progressBar({ delay: 250 }) })`.
export { progressBar } from '@marmeon/http/client';
export type { ProgressIndicator, ViewTransitionOption } from '@marmeon/http/client';
export type { PageInfo } from '@marmeon/http/page';
export { I18nContext, useLocale, useTranslation } from './i18n.tsx';
export type { I18nValue } from './i18n.tsx';
export type {
  CheckedPatch,
  ClientRouter,
  PartialReloadOptions,
  PatchedProps,
  PrefetchOptions,
  ProgressOptions,
  PropName,
  ReloadOptions,
  ReloadingOptions,
  TypedVisitOptions,
  Visit,
  VisitCallbacks,
  VisitError,
  VisitEvent,
  VisitEvents,
  VisitMethod,
  VisitOptions,
  VisitProgress,
} from './app.tsx';
export { Deferred } from './deferred.tsx';
export type { DeferredProps } from './deferred.tsx';
export { useForm } from './use-form.ts';
export { FileInput, useUpload } from './file-input.tsx';
export type { FileInputProps } from './file-input.tsx';
export { useFlash } from './flash.ts';
export type { FlashHandler } from './flash.ts';
export { useBlocker, useNewVersion, usePending } from './state.ts';
export type { NewVersion, UseBlockerOptions, UsePendingOptions } from './state.ts';
export { useRemember } from './remember.ts';
export type { RememberKey, UseRememberOptions } from './remember.ts';
export { Form } from './form.tsx';
export type { CheckFormElementRoute, FieldName, FormFieldsOf, FormProps, FormRenderState } from './form.tsx';
export { ConfirmDialog } from './confirm.tsx';
export type { Confirm, ConfirmAnswer, ConfirmComponent, ConfirmDialogProps, ConfirmOptions, ConfirmProps, ConfirmRequest } from './confirm.tsx';
export { useAction, usePendingSubmissions } from './use-action.ts';
export type { ActionError, ActionField, ActionReload, ActionResultOf, ActionSubmitOptions, ClientAction, PendingSubmission } from './use-action.ts';
export type { FieldPath, Form as FormHandle, FormField, FormOptions, FormState, FormSubmitOptions, LiveValidationSetting, PasswordNeverRemembered, RememberFormOptions, RouteForm, RouteFormFields, RouteFormOptions } from './use-form.ts';
export { useRoute } from './routes.ts';
export type { RouteFunction } from './routes.ts';
export { createMarmeonApp } from './client.tsx';
export type { CreateMarmeonAppOptions } from './client.tsx';
export { Link } from './link.tsx';
export { Island, useIsland } from './island.tsx';
export { useLayer } from './layer.tsx';
export { LayerDialog } from './layer-dialog.tsx';
export type { LayerDialogProps } from './layer-dialog.tsx';
export type { LayerCloseOptions, LayerFrame, LayerFrameProps, LayerState, LayerVariant, PageLayer, UseLayerOptions } from './layer.tsx';
export type { IslandElementProps, IslandReloadOptions, IslandState } from './island.tsx';
export type { ActiveMatch, LinkProps, PrefetchTrigger } from './link.tsx';
export { resolveModulePages } from './pages.ts';
export type { DefaultLayout, ErrorFallback, ErrorFallbackProps, Layout, LayoutProps, PageComponent, PageLayout, PageSsr, Placeholder, ResolvePage, RevalidateOnBack } from './pages.ts';
export { Head } from './head.tsx';
export type { HeadProps, JsonLd, OpenGraph, TitleTemplate, TwitterCard } from './head.tsx';
export { Pagination } from './pagination.tsx';
export type { PaginationLabels, PaginationProps } from './pagination.tsx';
export { usePoll } from './use-poll.ts';
export { useLiveUpdates } from './live.ts';
export type { LiveUpdatesState } from './live.ts';
export { useQueryState } from './use-query-state.ts';
export type { SetQueryState, UseQueryStateOptions } from './use-query-state.ts';
export type { UsePollOptions } from './use-poll.ts';
export { WhenVisible } from './when-visible.tsx';
export type { WhenVisibleProps } from './when-visible.tsx';

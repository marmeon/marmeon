/**
 * `@bespokecore/react` — the React rendering layer on the UI-free client core `@bespokecore/http/client` (E39):
 * components, hooks, context, layouts, error boundaries and `<Head>`. Visits, history, caching, prefetching, polling
 * and the progress bar come from the core (import `Navigator`, `createPoll` … from there).
 */
export { BespokeApp, useFeature, usePage, useRouter } from './app.tsx';
// The progress bar (E82, opt-in): `createBespokeApp({ progress: progressBar({ delay: 250 }) })`.
export { progressBar } from '@bespokecore/http/client';
export type { ProgressIndicator } from '@bespokecore/http/client';
export { I18nContext, useLocale, useTranslation } from './i18n.tsx';
export type { I18nValue } from './i18n.tsx';
export type {
  BespokeAppProps,
  CheckedPatch,
  PartialReloadOptions,
  PatchedProps,
  PrefetchOptions,
  ProgressOptions,
  PropName,
  ReloadOptions,
  ReloadingOptions,
  Router,
  TypedVisitOptions,
  Visit,
  VisitCallbacks,
  VisitEvent,
  VisitEvents,
  VisitException,
  VisitMethod,
  VisitOptions,
  VisitProgress,
} from './app.tsx';
export { Deferred } from './deferred.tsx';
export type { DeferredProps } from './deferred.tsx';
export { useForm } from './use-form.ts';
export { useFlash } from './flash.ts';
export type { FlashHandler } from './flash.ts';
export { SHORT_PENDING_DELAY, useBlocker, useNewVersion, usePending } from './state.ts';
export type { NewVersion, UseBlockerOptions, UsePendingOptions } from './state.ts';
export { useRemember } from './remember.ts';
export type { RememberKey, UseRememberOptions } from './remember.ts';
export { Form } from './form.tsx';
export type { CheckFormElementRoute, FieldName, FormFieldsOf, FormProps, FormRenderState } from './form.tsx';
export { ConfirmDialog } from './confirm.tsx';
export type { Confirm, ConfirmAnswer, ConfirmComponent, ConfirmDialogProps, ConfirmOptions, ConfirmProps, ConfirmRequest } from './confirm.tsx';
export { useAction, usePendingSubmissions } from './use-action.ts';
export type { Action, ActionException, ActionField, ActionReload, ActionResultOf, ActionSubmitOptions, PendingSubmission } from './use-action.ts';
export type { FieldPath, Form as FormHandle, FormOptions, FormState, FormSubmitOptions, LiveValidationSetting, PasswordNeverRemembered, RememberFormOptions, RouteForm, RouteFormFields, RouteFormOptions } from './use-form.ts';
export { useRoute } from './routes.ts';
export type { RouteFunction } from './routes.ts';
export { createBespokeApp } from './client.tsx';
export type { CreateBespokeAppOptions } from './client.tsx';
export { ErrorPage } from './error-page.tsx';
export { Link } from './link.tsx';
export { Island, useIsland } from './island.tsx';
export { useLayer } from './layer.tsx';
export { LayerDialog } from './layer-dialog.tsx';
export type { LayerDialogProps } from './layer-dialog.tsx';
export type { LayerCloseOptions, LayerFrame, LayerFrameProps, LayerState, LayerVariant, PageLayer, UseLayerOptions } from './layer.tsx';
export { Backdrop } from './backdrop.tsx';
export type { IslandElementProps, IslandReloadOptions, IslandState } from './island.tsx';
export type { ActiveMatch, LinkProps, PrefetchTrigger } from './link.tsx';
export { layoutsOf, resolveModulePages } from './pages.ts';
export type { DefaultLayout, Layout, LayoutProps, PageComponent, PageLayout, PageSsr, Placeholder, ResolvePage, RevalidateOnBack } from './pages.ts';
export { Head } from './head.tsx';
export type { HeadProps, TitleTemplate } from './head.tsx';
export { Pagination, pagesAround } from './pagination.tsx';
export type { PaginationProps } from './pagination.tsx';
export { usePoll } from './use-poll.ts';
export { useQueryState } from './use-query-state.ts';
export type { SetQueryState, UseQueryStateOptions } from './use-query-state.ts';
export type { UsePollOptions } from './use-poll.ts';
export { WhenVisible } from './when-visible.tsx';
export type { WhenVisibleProps } from './when-visible.tsx';

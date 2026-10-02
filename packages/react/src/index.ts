/**
 * `@bespokecore/react` — the React rendering layer on the UI-free client core `@bespokecore/http/client` (E39):
 * components, hooks, context, layouts, error boundaries and `<Head>`. Visits, history, caching, prefetching, polling
 * and the progress bar come from the core (import `Navigator`, `createPoll` … from there).
 */
export { BespokeApp, usePage, useRouter } from './app.tsx';
export { I18nContext, useLocale, useTranslation } from './i18n.tsx';
export type { I18nValue } from './i18n.tsx';
export type {
  BespokeAppProps,
  PartialReloadOptions,
  PrefetchOptions,
  ProgressOptions,
  PropName,
  ReloadOptions,
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
export type { Form, FormState, FormSubmitOptions, RouteForm, RouteFormFields } from './use-form.ts';
export { useRoute } from './routes.ts';
export type { RouteFunction } from './routes.ts';
export { createBespokeApp } from './client.tsx';
export type { CreateBespokeAppOptions } from './client.tsx';
export { ErrorPage } from './error-page.tsx';
export { Link } from './link.tsx';
export { Island, useIsland } from './island.tsx';
export { LayerDialog, useLayer } from './layer.tsx';
export type { LayerCloseOptions, LayerDialogProps, LayerFrame, LayerFrameProps, LayerState, LayerVariant, PageLayer, UseLayerOptions } from './layer.tsx';
export { Backdrop } from './backdrop.tsx';
export type { IslandElementProps, IslandReloadOptions, IslandState } from './island.tsx';
export type { LinkProps, PrefetchTrigger } from './link.tsx';
export { layoutsOf, resolveModulePages } from './pages.ts';
export type { DefaultLayout, Layout, LayoutProps, PageComponent, PageLayout, PageSsr, ResolvePage } from './pages.ts';
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

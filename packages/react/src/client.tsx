import {
  hasServerMarkup,
  loadHistoryFallback,
  loadPageMessages,
  loadTabSync,
  readInitialPage,
  rootElement,
  type DevtoolsGlobal,
  type Feature,
  type TitleTemplate,
} from '@marmeon/http/client';
import type { RouteManifest } from '@marmeon/http/page';
import type { MessageLoader } from '@marmeon/i18n/messages';
import { createRoot, hydrateRoot, type ErrorInfo } from 'react-dom/client';
import { MarmeonApp, loadLayerStack, type MarmeonAppProps } from './app.tsx';
import { SSR_ERROR_DIGEST } from './fallbacks.tsx';
import type { LayerFrame } from './layer.tsx';
import type { ConfirmComponent } from './confirm.tsx';
import type { DefaultLayout, ResolvePage } from './pages.ts';
import { loadView } from './views.ts';

export interface CreateMarmeonAppOptions {
  resolve: ResolvePage;
  /** Id of the element the server rendered into. */
  rootId?: string;
  /** Turns a page's `<Head title>` into the document title — the same as the SSR entry's. */
  title?: TitleTemplate;
  /** `routes` of `virtual:marmeon/routes`: what `route()`, `<Link route>` and `useForm(name, …)` resolve. */
  routes?: RouteManifest;
  /**
   * The layout of pages without their own `Page.layout` (E35), by page name — the same as the SSR entry's:
   * `layout: (name) => (name.startsWith('auth/') ? null : AppLayout)`.
   */
  layout?: DefaultLayout;
  /**
   * The app's language files — `createMessageLoader(lang)` with `lang` from `virtual:marmeon/lang` — the same as the SSR
   * entry's. Only the page's locale is loaded (one chunk per file), before hydrating; `useTranslation` reads them.
   */
  messages?: MessageLoader;
  /**
   * An indicator of visits under way (E82, opt-in): `progress: progressBar({ delay: 250 })` shows the core's bar for visits
   * slower than `delay`; none without it.
   */
  progress?: MarmeonAppProps['progress'];
  /**
   * The frame around every layer's view (E53) — the same as the SSR entry's. Default `LayerDialog` (a native modal
   * `<dialog>`); wrap it for the app's labels: `layer: (props) => <LayerDialog {...props} closeLabel="Schließen" />`.
   */
  layer?: LayerFrame;
  /**
   * The dialog that asks the user (E64) — a link's, an action's or a form's `confirm`, the navigation guard's question:
   * `ConfirmDialog` (wrap it for the app's labels), or the app's own. Default: the browser's `confirm()` and `prompt()`.
   */
  confirm?: ConfirmComponent;
  /**
   * Tab sync (W8 step 8, E148/E149) — on by default: when another tab of the browser signs in or out (or switches the language),
   * this one lets go of everything it keeps (pages in memory, islands, pages fetched ahead, once props, remembered input) and
   * loads again — or, with unsaved changes on screen, asks first. Its code loads with the first page, before hydrating.
   * `false` leaves it out: then a tab keeps what it shows after a sign-out elsewhere until its next request (the known risk E66).
   */
  tabSync?: false;
  /**
   * View transitions for every page change (E185) — off by default; a visit (`router.visit(url, { viewTransition: true })`) or a link
   * (`<Link viewTransition>`) turns one on for itself. `true` (or `{ types: ['slide'] }`): the core's — `document.startViewTransition`
   * around each page swap, the browser crossfades the page, the app's CSS animates the rest (`::view-transition-*`,
   * `:active-view-transition-type(back)`). `'react'`: React 19.3's — each page change renders in `startTransition` with its types
   * (`addTransitionType`), the `<ViewTransition>` components of the views animate (enter, exit, share); React starts the transition,
   * the core never does. Both skip it under `prefers-reduced-motion: reduce` and in a hidden tab. Its code loads with the first page change.
   */
  viewTransition?: MarmeonAppProps['viewTransition'];
  /**
   * Errors React recovered from while hydrating: the server's markup did not match (React rendered that part again in
   * the browser), or a part failed on the server (the browser rendered it). Default: reported to the console — in
   * development with the page's name and a notice on the page, so a mismatch is not missed.
   */
  onRecoverableError?: (error: unknown, info: ErrorInfo) => void;
}

/**
 * Client entry point: hydrates the server-rendered page and takes over navigation. Without server markup — server
 * rendering failed (the server logged why) or the page has `ssr = false` — it renders the page itself.
 */
export async function createMarmeonApp({ resolve, rootId = 'app', title, routes, layout, messages, progress, layer, confirm, tabSync, viewTransition, onRecoverableError }: CreateMarmeonAppOptions): Promise<void> {
  const page = readInitialPage();

  // Resolve before hydrating so the first client render matches the server HTML — the component and the messages of
  // the page's locale. The history entry is the navigator's (<MarmeonApp> starts it): its key and URL — never the
  // page's props (E36).
  // A deep link's layers (E53) too: the layer stack with the core's layers (E71) and their views render in the server's markup.
  // Tab sync (E149) loads beside them — a chunk of its own, attached from the start: no message of another tab is missed. A chunk
  // that cannot load leaves it out (the page works without it).
  const [Component, catalog, root, synced, fallback] = await Promise.all([
    resolve(page.component),
    loadPageMessages(page, messages),
    rootElement(rootId),
    tabSync === false ? undefined : loadTabSync().catch(() => undefined),
    // Without the Navigation API (E184): the History fallback, a chunk of its own.
    window.navigation ? undefined : loadHistoryFallback(),
    ...(page.layers?.length ? [loadLayerStack(), ...page.layers.map((layered) => loadView(resolve, layered.component))] : []),
  ]);
  const app = (
    <MarmeonApp
      initialPage={page}
      initialComponent={Component}
      resolve={resolve}
      title={title}
      routes={routes}
      layout={layout}
      progress={progress}
      messages={messages}
      initialCatalog={catalog}
      layer={layer}
      confirm={confirm}
      features={[fallback, synced].filter(Boolean) as Feature[]}
      viewTransition={viewTransition}
    />
  );

  if (!hasServerMarkup(root)) {
    createRoot(root).render(app);
    return;
  }
  hydrateRoot(root, app, { onRecoverableError: onRecoverableError ?? ((error) => reportRecoverable(error, page.component)) });
}

/** React's own report (the console), and in development the page's name and a notice on the page. */
function reportRecoverable(error: unknown, component: string): void {
  // Development (and tests) only: a bundler replaces `process.env.NODE_ENV`, and a production bundle drops the explanations.
  // Positive (E201): a staging build reports like production — no notice on the page.
  if (!(process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test')) {
    globalThis.reportError?.(error);
    return;
  }
  const server = (error as { digest?: unknown } | null)?.digest === SSR_ERROR_DIGEST;
  const message = server
    ? `[marmeon] A part of [${component}] failed on the server (see the server log); the browser rendered it instead.`
    : `[marmeon] Hydration mismatch in [${component}]: the server rendered other markup than the browser, so React rendered it ` +
      'again in the browser. Common causes: values that differ between server and browser (Date.now(), Math.random(), ' +
      'locale formatting, `typeof window` branches) — render those in an effect, or set the page’s ssr = false.';
  console.error(message, error);
  showNotice(message);
  // The devtools' bar (W7 step 9) lists it in its SSR tab — `__MARMEON_DEVTOOLS_HOOK__` exists only where its client was served.
  (globalThis as DevtoolsGlobal).__MARMEON_DEVTOOLS_HOOK__?.recoverable?.(error, component, server);
}

const NOTICE_ATTRIBUTE = 'data-marmeon-hydration';

/** A notice at the bottom of the page — plain DOM: it happens while React hydrates. One at a time. */
function showNotice(message: string): void {
  if (document.querySelector(`[${NOTICE_ATTRIBUTE}]`)) return;
  const notice = document.createElement('div');
  notice.setAttribute('role', 'alert');
  notice.setAttribute(NOTICE_ATTRIBUTE, '');
  // Inline style properties: a strict Content-Security-Policy does not block them (no <style> element).
  Object.assign(notice.style, {
    position: 'fixed',
    insetInline: '16px',
    bottom: '16px',
    zIndex: '2147483646',
    padding: '12px 16px',
    borderRadius: '8px',
    font: '14px/1.4 system-ui, sans-serif',
    background: '#7f1d1d',
    color: '#fef2f2',
    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.25)',
  });
  notice.textContent = `${message} (development only — details in the console)`;
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.textContent = 'Dismiss';
  Object.assign(dismiss.style, { marginInlineStart: '8px', font: 'inherit', cursor: 'pointer' });
  dismiss.addEventListener('click', () => notice.remove());
  notice.append(dismiss);
  document.body.append(notice);
}

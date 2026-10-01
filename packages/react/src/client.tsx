import { hasServerMarkup, isDevelopment, loadPageMessages, readInitialPage, rootElement, type ProgressOptions, type TitleTemplate } from '@bespokecore/http/client';
import type { RouteManifest } from '@bespokecore/http/page';
import type { MessageLoader } from '@bespokecore/i18n/messages';
import { createRoot, hydrateRoot, type ErrorInfo } from 'react-dom/client';
import { BespokeApp } from './app.tsx';
import { SSR_ERROR_DIGEST } from './fallbacks.tsx';
import type { DefaultLayout, ResolvePage } from './pages.ts';

export interface CreateBespokeAppOptions {
  resolve: ResolvePage;
  /** Id of the element the server rendered into. */
  rootId?: string;
  /** Turns a page's `<Head title>` into the document title — the same as the SSR entry's. */
  title?: TitleTemplate;
  /** `routes` of the generated `bootstrap/routes.ts`: what `route()`, `<Link route>` and `useForm(name, …)` resolve. */
  routes?: RouteManifest;
  /**
   * The layout of pages without their own `Page.layout` (E35), by page name — the same as the SSR entry's:
   * `layout: (name) => (name.startsWith('auth/') ? null : AppLayout)`.
   */
  layout?: DefaultLayout;
  /**
   * The app's language files — `createMessageLoader(lang)` with `lang` from `virtual:bespoke/lang` — the same as the SSR
   * entry's. Only the page's locale is loaded (one chunk per file), before hydrating; `useTranslation` reads them.
   */
  messages?: MessageLoader;
  /** The progress bar of visits: `{ delay: 250 }` (the default — fast visits show none), or `false`. */
  progress?: ProgressOptions | false;
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
export async function createBespokeApp({ resolve, rootId = 'app', title, routes, layout, messages, progress, onRecoverableError }: CreateBespokeAppOptions): Promise<void> {
  const page = readInitialPage();

  // Resolve before hydrating so the first client render matches the server HTML — the component and the messages of
  // the page's locale. The history entry is the navigator's (<BespokeApp> starts it): its key and URL — never the
  // page's props (E36).
  const [Component, catalog, root] = await Promise.all([resolve(page.component), loadPageMessages(page, messages), rootElement(rootId)]);
  const app = (
    <BespokeApp
      initialPage={page}
      initialComponent={Component}
      resolve={resolve}
      title={title}
      routes={routes}
      layout={layout}
      progress={progress}
      messages={messages}
      initialCatalog={catalog}
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
  if (!isDevelopment()) {
    globalThis.reportError?.(error);
    return;
  }
  const server = (error as { digest?: unknown } | null)?.digest === SSR_ERROR_DIGEST;
  const message = server
    ? `[bespoke] A part of [${component}] failed on the server (see the server log); the browser rendered it instead.`
    : `[bespoke] Hydration mismatch in [${component}]: the server rendered other markup than the browser, so React rendered it ` +
      'again in the browser. Common causes: values that differ between server and browser (Date.now(), Math.random(), ' +
      'locale formatting, `typeof window` branches) — render those in an effect, or set the page’s ssr = false.';
  console.error(message, error);
  showNotice(message);
}

const NOTICE_ATTRIBUTE = 'data-bespoke-hydration';

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

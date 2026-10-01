import { isPageObject, PAGE_SCRIPT_ID, type PageObject, type RouteManifest } from '@bespokecore/http/page';
import { createRoot, hydrateRoot, type ErrorInfo } from 'react-dom/client';
import { BespokeApp } from './app.tsx';
import { isDevelopment, SSR_ERROR_DIGEST } from './fallbacks.tsx';
import type { TitleTemplate } from './head.tsx';
import type { DefaultLayout, ResolvePage } from './pages.ts';
import type { ProgressOptions } from './progress.ts';

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
  /** The progress bar of visits: `{ delay: 250 }` (the default — fast visits show none), or `false`. */
  progress?: ProgressOptions | false;
  /**
   * Errors React recovered from while hydrating: the server's markup did not match (React rendered that part again in
   * the browser), or a part failed on the server (the browser rendered it). Default: reported to the console — in
   * development with the page's name and a notice on the page, so a mismatch is not missed.
   */
  onRecoverableError?: (error: unknown, info: ErrorInfo) => void;
}

function readInitialPage(): PageObject {
  const page: unknown = JSON.parse(document.getElementById(PAGE_SCRIPT_ID)?.textContent ?? 'null');
  if (!isPageObject(page)) throw new Error(`Missing or invalid #${PAGE_SCRIPT_ID} script — was the page server-rendered?`);
  return page;
}

/** The root element — the client may start while a streamed document is still arriving. */
async function rootElement(rootId: string): Promise<HTMLElement> {
  let root = document.getElementById(rootId);
  if (!root && document.readyState === 'loading') {
    await new Promise((resolve) => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
    root = document.getElementById(rootId);
  }
  if (!root) throw new Error(`Root element #${rootId} not found.`);
  return root;
}

/** Whether the server rendered markup into `root` (it sends none when server rendering failed or is off). */
function hasMarkup(root: HTMLElement): boolean {
  return [...root.childNodes].some((node) => node.nodeType !== Node.TEXT_NODE || (node.textContent ?? '').trim() !== '');
}

/**
 * Client entry point: hydrates the server-rendered page and takes over navigation. Without server markup — server
 * rendering failed (the server logged why) or the page has `ssr = false` — it renders the page itself.
 */
export async function createBespokeApp({ resolve, rootId = 'app', title, routes, layout, progress, onRecoverableError }: CreateBespokeAppOptions): Promise<void> {
  const page = readInitialPage();
  const root = await rootElement(rootId);

  // Resolve before hydrating so the first client render matches the server HTML. The history entry is the
  // navigator's (<BespokeApp> starts it): its key and URL — never the page's props (E36).
  const Component = await resolve(page.component);
  const app = <BespokeApp initialPage={page} initialComponent={Component} resolve={resolve} title={title} routes={routes} layout={layout} progress={progress} />;

  if (!hasMarkup(root)) {
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

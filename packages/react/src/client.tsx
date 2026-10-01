import { isPageObject, PAGE_SCRIPT_ID, type PageObject, type RouteManifest } from '@bespokecore/http/page';
import { hydrateRoot } from 'react-dom/client';
import { BespokeApp } from './app.tsx';
import type { TitleTemplate } from './head.tsx';
import type { ResolvePage } from './pages.ts';

export interface CreateBespokeAppOptions {
  resolve: ResolvePage;
  /** Id of the element the server rendered into. */
  rootId?: string;
  /** Turns a page's `<Head title>` into the document title — the same as the SSR entry's. */
  title?: TitleTemplate;
  /** `routes` of the generated `bootstrap/routes.ts`: what `route()`, `<Link route>` and `useForm(name, …)` resolve. */
  routes?: RouteManifest;
}

function readInitialPage(): PageObject {
  const page: unknown = JSON.parse(document.getElementById(PAGE_SCRIPT_ID)?.textContent ?? 'null');
  if (!isPageObject(page)) throw new Error(`Missing or invalid #${PAGE_SCRIPT_ID} script — was the page server-rendered?`);
  return page;
}

/** Client entry point: hydrates the server-rendered page and takes over navigation. */
export async function createBespokeApp({ resolve, rootId = 'app', title, routes }: CreateBespokeAppOptions): Promise<void> {
  const page = readInitialPage();
  const root = document.getElementById(rootId);
  if (!root) throw new Error(`Root element #${rootId} not found.`);

  // Resolve before hydrating so the first client render matches the server HTML. The history entry is the
  // navigator's (<BespokeApp> starts it): its key and URL — never the page's props (E36).
  const Component = await resolve(page.component);

  hydrateRoot(root, <BespokeApp initialPage={page} initialComponent={Component} resolve={resolve} title={title} routes={routes} />);
}

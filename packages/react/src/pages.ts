import { ERROR_PAGE, pageName } from '@bespokecore/http/page';
import type { ComponentType, ReactNode } from 'react';
import { ErrorPage } from './error-page.tsx';

/** A layout: a component around pages — `function AppLayout({ children }: LayoutProps) { … }`. Shared data via `usePage()`. */
export type Layout = ComponentType<LayoutProps>;

export interface LayoutProps {
  children: ReactNode;
}

/**
 * The layouts of a page, outermost first (E35): `Show.layout = AppLayout` or `[AppLayout, SettingsLayout]`.
 * A layout that the next page has too stays mounted — its state (and scroll position) survives the navigation.
 * `null` (or `[]`): no layout, not even the app's default. Check one with `satisfies PageLayout`.
 */
export type PageLayout = Layout | readonly Layout[] | null;

/**
 * How the server renders a page: `true` (the default) streams it — the shell at once, Suspense boundaries as they
 * finish; `'complete'` waits for the whole page before sending (as for bots); `false` sends no markup, the browser
 * renders the page (for pages that need the browser to render at all).
 */
export type PageSsr = boolean | 'complete';

// Page props are validated at the controller boundary (PageProps<...>), not here.
export type PageComponent = ComponentType<any> & { layout?: PageLayout; ssr?: PageSsr };

/** The app's default layout per page name — for pages without their own `layout`: `createBespokeApp({ layout: () => AppLayout })`. */
export type DefaultLayout = (name: string) => PageLayout | undefined;

/** The layouts a page renders in, outermost first: its own, else the app's default. */
export function layoutsOf(page: PageComponent, name: string, defaultLayout?: DefaultLayout): readonly Layout[] {
  const layout = page.layout !== undefined ? page.layout : defaultLayout?.(name);
  if (layout === undefined || layout === null) return [];
  return isLayoutList(layout) ? layout : [layout];
}

function isLayoutList(layout: Layout | readonly Layout[]): layout is readonly Layout[] {
  return Array.isArray(layout);
}

/** A component React can render: a function, a class, or a memo/forwardRef/lazy object. */
function isComponent(value: unknown): boolean {
  return typeof value === 'function' || (typeof value === 'object' && value !== null && '$$typeof' in value);
}

function checkLayout(name: string, layout: unknown): void {
  if (layout === undefined || layout === null) return;
  const layouts: unknown[] = Array.isArray(layout) ? layout : [layout];
  const invalid = layouts.findIndex((entry) => !isComponent(entry));
  if (invalid !== -1) {
    throw new Error(`Page [${name}] has an invalid layout${Array.isArray(layout) ? ` at index ${invalid}` : ''}: expected a component (or a list of them), got ${String(layouts[invalid])}.`);
  }
}

export type ResolvePage = (name: string) => Promise<PageComponent>;

type PageModules = Record<string, () => Promise<unknown>>;

/**
 * Maps the modular-monolith view convention to page names:
 * `modules/user-profile/views/Show.tsx` -> `user-profile/Show`.
 *
 * ```ts
 * import pages from 'virtual:bespoke/pages'; // from bespoke() in @bespokecore/vite
 * resolveModulePages(pages)
 * ```
 */
export function resolveModulePages(modules: PageModules): ResolvePage {
  const pages = new Map<string, PageModules[string]>();
  for (const [path, load] of Object.entries(modules)) {
    const name = pageName(path);
    if (name) pages.set(name, load);
  }

  return async (name) => {
    const load = pages.get(name);
    if (!load && name === ERROR_PAGE) return ErrorPage; // built-in until the app brings its own
    if (!load) {
      const [module, ...rest] = name.split('/');
      throw new Error(`Page [${name}] not found. Expected a default export in modules/${module}/views/${rest.join('/')}.tsx`);
    }
    const module = await load();
    if (typeof module !== 'object' || module === null || !('default' in module)) {
      throw new Error(`Page [${name}] has no default export.`);
    }
    const page = module.default as PageComponent;
    checkLayout(name, page.layout);
    if (page.ssr !== undefined && page.ssr !== true && page.ssr !== false && page.ssr !== 'complete') {
      throw new Error(`Page [${name}] has an invalid ssr: expected true, false or 'complete', got ${JSON.stringify(page.ssr)}.`);
    }
    return page;
  };
}

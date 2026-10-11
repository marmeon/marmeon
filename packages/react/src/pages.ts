import { revalidateOnBack, type Feature } from '@marmeon/http/client';
import { ERROR_PAGE, LAYER_BACKDROP, pageName, type InstantProps, type IslandProps, type PageProps } from '@marmeon/http/page';
import type { ComponentType, ReactNode } from 'react';
import { Backdrop } from './backdrop.tsx';
import type { PageLayer } from './layer.tsx';

/** A layout: a component around pages — `function AppLayout({ children }: LayoutProps) { … }`. Shared data via `usePage()`. */
export type Layout = ComponentType<LayoutProps>;

export interface LayoutProps {
  children: ReactNode;
}

/**
 * The layouts of a page, outermost first: `Show.layout = AppLayout` or `[AppLayout, SettingsLayout]`.
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

type ViewAction = { handle: (...args: never[]) => unknown };

/** The props of the view of controller `C`: a page's (or a layer's), else an island's. */
type ViewPropsOf<C extends ViewAction> = [PageProps<C>] extends [never] ? IslandProps<C> : PageProps<C>;

/**
 * What a view reloads when Back/Forward shows it from memory — checked against its controller's props:
 * `Show.revalidateOnBack = ['activity'] as const satisfies RevalidateOnBack<ShowUserProfileController>`. `true`: all of
 * them; a list: those (an `optional()`/`defer()` prop too); `false` or nothing: none — Back shows what memory has, as it was.
 * For pages, layers and islands alike.
 */
export type RevalidateOnBack<C extends ViewAction> = boolean | readonly (keyof ViewPropsOf<C> & string)[];

// Page props are validated at the controller boundary (PageProps<...>), not here.
export type PageComponent = ComponentType<any> & {
  layout?: PageLayout;
  ssr?: PageSsr;
  /** How the view looks when it is a layer: `'modal'` (the default), `'slideover'`, or a frame of its own. */
  layer?: PageLayer;
  /**
   * What reloads when Back/Forward shows the view from memory: `true`, some props, or (the default) none — shown at once,
   * then reloaded in the background without a progress bar. See {@link RevalidateOnBack}.
   */
  revalidateOnBack?: boolean | readonly string[];
  /**
   * What an instant visit shows before the view's answer lands: `Show.placeholder = ShowPlaceholder` — a skeleton, with
   * what the link hands it (`<Link instant={{ name }}>`), typed by the controller: `satisfies Placeholder<ShowUserProfileController>`.
   */
  placeholder?: ComponentType<any>;
};

/**
 * The placeholder of controller `C`'s view: a component taking what `C` declares a link may hand it —
 * `declare readonly instant: { name: string }` — never the page's props (it renders before they arrive).
 * `Show.placeholder = ShowPlaceholder satisfies Placeholder<ShowUserProfileController>`.
 */
export type Placeholder<C> = [InstantProps<C>] extends [never]
  ? 'this controller declares no placeholder props — add `declare readonly instant: { … }` to it (`{}` for none)'
  : ComponentType<InstantProps<C>>;

/** The app's default layout per page name — for pages without their own `layout`: `createMarmeonApp({ layout: () => AppLayout })`. */
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
    throw new Error(
      (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test')
        ? `[marmeon:R1] Page [${name}] has an invalid layout${Array.isArray(layout) ? ` at index ${invalid}` : ''}: expected a component (or a list of them), got ${String(layouts[invalid])}.`
        : `[marmeon:R1] ${name}`,
    );
  }
}

export type ResolvePage = ((name: string) => Promise<PageComponent>) & {
  /**
   * The client features its views use — `<MarmeonApp>` attaches them to its navigator. `resolveModulePages` brings
   * `revalidateOnBack`: any of its views may declare it, and an app without the resolver carries none of its code.
   */
  readonly features?: readonly Feature[];
};

type PageModules = Record<string, () => Promise<unknown>>;

/**
 * Maps the modular-monolith view convention to page names:
 * `modules/user-profile/views/Show.tsx` -> `user-profile/Show`.
 *
 * ```ts
 * import pages from 'virtual:marmeon/pages'; // from marmeon() in @marmeon/vite
 * resolveModulePages(pages)
 * ```
 */
export function resolveModulePages(modules: PageModules): ResolvePage {
  const pages = new Map<string, PageModules[string]>();
  for (const [path, load] of Object.entries(modules)) {
    const name = pageName(path);
    if (name && !name.includes('::')) pages.set(name, load); // `::` belongs to the pages of packages; `route:types` refuses it, this holds if it did not run
  }

  const resolve = async (name: string): Promise<PageComponent> => {
    const load = pages.get(name);
    if (!load && name === ERROR_PAGE) return (await import('./error-page.tsx')).ErrorPage; // built-in until the app brings its own (a chunk of its own)
    if (!load && name === LAYER_BACKDROP) return Backdrop; // the neutral surface under a layer whose base is not shown
    if (!load) {
      const [module, ...rest] = name.split('/');
      throw new Error(
        process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test' ? `[marmeon:R2] Page [${name}] not found. Expected a default export in modules/${module}/views/${rest.join('/')}.tsx` : `[marmeon:R2] ${name}`,
      );
    }
    const module = await load();
    if (typeof module !== 'object' || module === null || !('default' in module)) {
      throw new Error(process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test' ? `[marmeon:R3] Page [${name}] has no default export.` : `[marmeon:R3] ${name}`);
    }
    const page = module.default as PageComponent;
    checkLayout(name, page.layout);
    if (page.ssr !== undefined && page.ssr !== true && page.ssr !== false && page.ssr !== 'complete') {
      throw new Error(
        process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test' ? `[marmeon:R4] Page [${name}] has an invalid ssr: expected true, false or 'complete', got ${JSON.stringify(page.ssr)}.` : `[marmeon:R4] ${name}`,
      );
    }
    if (page.placeholder !== undefined && !isComponent(page.placeholder)) {
      throw new Error(
        process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test' ? `[marmeon:R5] Page [${name}] has an invalid placeholder: expected a component, got ${String(page.placeholder)}.` : `[marmeon:R5] ${name}`,
      );
    }
    const revalidate: unknown = page.revalidateOnBack;
    if (revalidate !== undefined && typeof revalidate !== 'boolean' && !(Array.isArray(revalidate) && revalidate.every((prop) => typeof prop === 'string' && prop !== ''))) {
      throw new Error(
        (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test')
          ? `[marmeon:R6] Page [${name}] has an invalid revalidateOnBack: expected true, false or a list of prop names, got ${JSON.stringify(revalidate)}.`
          : `[marmeon:R6] ${name}`,
      );
    }
    return page;
  };
  return Object.assign(resolve, { features: [revalidateOnBack] });
}

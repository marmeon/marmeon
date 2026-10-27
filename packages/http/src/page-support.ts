/**
 * What the server and the UI adapters share of a page and that an app has no use for: the page's view of itself, the
 * names of the framework's own views, the JSON a document carries. The server reaches it through `@marmeon/http/internal`,
 * an adapter through `@marmeon/http/client/adapter`. Free of server code, so the browser can import it.
 */
import type { PageInfo } from './page.ts';
import type { PageObject } from './protocol.ts';
import type { ViewProps } from './view.ts';

/** The {@link PageInfo} of a page object — only its fields: a field added to the wire format never reaches the app by itself. */
export function pageInfo<TProps = ViewProps>(page: PageObject): PageInfo<TProps> {
  return {
    component: page.component,
    props: page.props as TProps,
    url: page.url,
    ...(page.route !== undefined && { route: page.route }),
    ...(page.locale !== undefined && { locale: page.locale }),
    ...(page.query !== undefined && { query: page.query }),
    ...(page.flash !== undefined && { flash: page.flash }),
  };
}

/**
 * The neutral surface under a layer whose base the user may not see — a deep link to the layer renders it alone over
 * this page, and the base's data is never loaded. Apps override it with `modules/system/views/layers/Backdrop.tsx`.
 */
export const LAYER_BACKDROP = 'system/layers/Backdrop';

/**
 * JSON for a `<script type="application/json">` in HTML: `<` is escaped (`<`), so a value can never close the script
 * element early (`</script>`) or open a comment — the page object, islands and deferred props streamed into the document.
 */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}

/** The page every error renders. Apps override it with `modules/system/views/errors/Error.tsx`. */
export const ERROR_PAGE = 'system/errors/Error';

/** The props of the error page (`modules/system/views/errors/Error.tsx`). See docs/errors.md#your-own-error-page. */
export interface ErrorPageProps {
  status: number;
  title: string;
  message: string;
  /** Only in debug mode. */
  exception: { name: string; message: string; stack: string } | null;
}

/**
 * `modules/user-profile/views/Show.tsx` → `user-profile/Show` (the page naming convention), or undefined. Bound to the app's
 * root, so a file outside its modules (`node_modules/x/modules/…`) never gets the name of an app page.
 */
export function pageName(path: string): string | undefined {
  const match = /^\/?modules\/([^/]+)\/views\/(.+)\.[jt]sx$/.exec(path.replaceAll('\\', '/'));
  return match ? `${match[1]}/${match[2]}` : undefined;
}

/**
 * Where the framework's own pages (the error pages, the layer backdrop) live now, for a file in the former place of one:
 * `modules/errors/views/404.tsx` → `modules/system/views/errors/404.tsx`. Undefined for every other file, so a module
 * of the app that happens to be named `errors` is left alone.
 */
export function legacyFrameworkPage(path: string): string | undefined {
  const file = path.replaceAll('\\', '/').replace(/^\//, '');
  const error = /^modules\/errors\/views\/(Error|\d{3})\.[jt]sx$/.exec(file);
  if (error) return `modules/system/views/errors/${error[1]}.tsx`;
  return /^modules\/layers\/views\/Backdrop\.[jt]sx$/.test(file) ? 'modules/system/views/layers/Backdrop.tsx' : undefined;
}

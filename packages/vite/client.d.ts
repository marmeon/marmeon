// Types for the virtual modules of `bespoke()`. Add `"@bespokecore/vite/client"` to `compilerOptions.types`.

declare module 'virtual:bespoke/pages' {
  /**
   * Every page component under `modules/<module>/views/` (the `pages` glob of `bespoke()`), keyed by its
   * path from the app root (`/modules/user-profile/views/Show.tsx`) and loaded lazily — one chunk per page.
   * Hand it to the UI adapter, e.g. `resolveModulePages(pages)` from `@bespokecore/react`.
   */
  const pages: Record<string, () => Promise<unknown>>;
  export default pages;
}

declare module 'virtual:bespoke/lang' {
  /**
   * Every language file — `modules/<module>/lang/<locale>.ts` and the app-wide `lang/<locale>.ts` (the `lang` glob of
   * `bespoke()`), keyed by its path from the app root and loaded lazily: one chunk per file, so the browser loads only
   * the locale it shows. Hand it to `createMessageLoader(lang)` from `@bespokecore/i18n/messages`.
   */
  const lang: Record<string, () => Promise<unknown>>;
  export default lang;
}

declare module 'virtual:bespoke/routes' {
  /**
   * The named routes the browser knows — hand them to `createBespokeApp({ routes })` and `createSsrRenderer(…, { routes })`.
   * A client build carries only the names its code writes out (`<Link route>`, `route()` of `useRoute()`,
   * `useForm(name, …)`); the server and the dev server have every route the browser may learn. `.internal()` routes,
   * API routes and `clientRoutes.except` are never in it. From `.bespoke/routes.json` (`bespoke route:types`).
   */
  export const routes: Readonly<Record<string, { readonly method: string; readonly path: string }>>;
}

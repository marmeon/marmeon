// Types for the virtual modules of `marmeon()`. Add `"@marmeon/vite/client"` to `compilerOptions.types`.

declare module 'virtual:marmeon/pages' {
  /**
   * Every page component (the `pages` glob of `marmeon()`), keyed by its path from the app root
   * (`/modules/user-profile/views/Show.tsx`) and loaded lazily. Hand it to `resolveModulePages(pages)` of `@marmeon/react`.
   */
  const pages: Record<string, () => Promise<unknown>>;
  export default pages;
}

declare module 'virtual:marmeon/lang' {
  /**
   * Every language file (the `lang` glob of `marmeon()`), keyed by its path from the app root and loaded lazily, one chunk
   * per file. Hand it to `createMessageLoader(lang)` of `@marmeon/i18n/messages`.
   */
  const lang: Record<string, () => Promise<unknown>>;
  export default lang;
}

declare module 'virtual:marmeon/routes' {
  /**
   * The named routes the browser knows — hand them to `createMarmeonApp({ routes })` and `createSsrRenderer(…, { routes })`.
   * A client build carries only the names its code writes out. See docs/urls.md#which-routes-the-browser-knows.
   */
  export const routes: Readonly<Record<string, { readonly method: string; readonly path: string }>>;
}

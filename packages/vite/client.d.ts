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
   * per file, so the browser loads only the locale it shows. Hand it to `createMessageLoader(lang)` of `@marmeon/i18n/messages`.
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

declare module 'virtual:marmeon/fonts.css' {
  // A stylesheet: a `<family> Fallback` font for each `fonts` entry of `marmeon()` with `family` and `fallback`. Import it
  // from the client entry. See docs/vite.md#fonts.
}

declare module '*?image' {
  /**
   * The image as an `ImageSource` for `<Image>`: built to several widths and formats by `sharp` in a build, the original with its
   * size in development. See docs/images.md#images-of-the-app.
   */
  const image: import('@marmeon/http/page').ImageSource;
  export default image;
}

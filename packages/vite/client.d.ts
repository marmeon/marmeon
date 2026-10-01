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

import { ERROR_PAGE, pageName } from '@bespokecore/http/page';
import type { ComponentType } from 'react';
import { ErrorPage } from './error-page.tsx';

// Page props are validated at the controller boundary (PageProps<...>), not here.
export type PageComponent = ComponentType<any>;

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
    return module.default as PageComponent;
  };
}

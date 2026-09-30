import { ERROR_PAGE } from '@bespokecore/http/page';
import type { ComponentType } from 'react';
import { ErrorPage } from './error-page.tsx';

// Page props are validated at the controller boundary (PageProps<...>), not here.
export type PageComponent = ComponentType<any>;

export type ResolvePage = (name: string) => Promise<PageComponent>;

type PageModules = Record<string, () => Promise<unknown>>;

const MODULE_VIEW = /modules\/([^/]+)\/views\/(.+)\.[jt]sx$/;

/**
 * Maps the modular-monolith view convention to page names:
 * `modules/user-profile/views/Show.tsx` -> `user-profile/Show`.
 *
 * ```ts
 * resolveModulePages(import.meta.glob('../modules/*\/views/**\/*.tsx'))
 * ```
 */
export function resolveModulePages(modules: PageModules): ResolvePage {
  const pages = new Map<string, PageModules[string]>();
  for (const [path, load] of Object.entries(modules)) {
    const match = MODULE_VIEW.exec(path);
    if (match) pages.set(`${match[1]}/${match[2]}`, load);
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

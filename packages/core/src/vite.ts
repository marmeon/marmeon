import { injectConstructorDependencies } from './injection/analyze.ts';

/** The subset of Vite's plugin interface this plugin uses — keeps `vite` out of core's dependencies. */
export interface InjectionPlugin {
  name: string;
  enforce: 'pre';
  transform(code: string, id: string): { code: string; map: null } | null;
}

/**
 * Vite plugin with the same transform as `@bespokecore/core/register`, for code that
 * Vite loads (Vitest, SSR). Runs before Vite strips the types (`enforce: 'pre'`).
 */
export function bespokeInjection(): InjectionPlugin {
  return {
    name: 'bespokecore:injection',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0]!;
      if (!/\.[cm]?tsx?$/.test(file) || file.includes('/node_modules/')) return null;

      const output = injectConstructorDependencies(code, file);
      // Insertions stay on the class's own line, so the existing mapping is still accurate.
      return output === code ? null : { code: output, map: null };
    },
  };
}

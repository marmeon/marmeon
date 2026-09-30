import { bespokeInjection } from '@bespokecore/core/vite';

/**
 * Vite/Vitest plugins for testing a BespokeCore app — constructor injection for the
 * code Vitest loads:
 *
 * ```ts
 * // vitest.config.ts
 * export default defineConfig({ plugins: [bespokeTesting()] });
 * ```
 */
export function bespokeTesting() {
  return [bespokeInjection()];
}

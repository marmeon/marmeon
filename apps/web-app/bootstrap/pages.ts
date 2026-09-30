import { resolveModulePages } from '@bespokecore/react';

/** Every `modules/<module>/views/**` component, code-split per page. */
export const resolvePage = resolveModulePages(import.meta.glob('../modules/*/views/**/*.tsx'));

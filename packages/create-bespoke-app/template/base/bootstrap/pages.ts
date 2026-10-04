import { resolveModulePages } from '@bespokecore/react';
import pages from 'virtual:bespoke/pages';

/** Every `modules/<module>/views/**` component, code-split per page. */
export const resolvePage = resolveModulePages(pages);

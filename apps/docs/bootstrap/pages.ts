import { resolveModulePages } from '@marmeon/react';
import pages from 'virtual:marmeon/pages';

/** Every `modules/<module>/views/**` component, code-split per page. */
export const resolvePage = resolveModulePages(pages);

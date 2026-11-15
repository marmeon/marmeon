import { resolveModulePages } from '@marmeon/react';
import pages from 'virtual:marmeon/pages/office';

/** The back office's pages: `office::Overview` for `views/Overview.tsx`. */
export const resolvePage = resolveModulePages(pages);

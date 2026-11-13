import { resolveModulePages } from '@marmeon/react';
import pages from 'virtual:marmeon/pages/status';

/** The area's pages: `status::Index` for `views/Index.tsx`. */
export const resolvePage = resolveModulePages(pages);

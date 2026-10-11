import type { DefaultLayout } from '@marmeon/react';
import { DocsLayout } from '../layouts/DocsLayout.tsx';
import { SiteLayout } from '../layouts/SiteLayout.tsx';

/** The docs pages render in the docs layout; the landing page and the error page (also for a 404, which has no route) in the site layout. */
export const layout: DefaultLayout = (name) => (name.startsWith('docs/') ? DocsLayout : SiteLayout);

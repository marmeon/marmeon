import type { DefaultLayout } from '@marmeon/react';
import { DocsLayout } from '../layouts/DocsLayout.tsx';
import { SiteLayout } from '../layouts/SiteLayout.tsx';
import { withPageviews } from '../modules/site/components/Pageviews.tsx';

const Docs = withPageviews(DocsLayout);
const Site = withPageviews(SiteLayout);

/** The docs pages render in the docs layout; the landing page and the error page (also for a 404, which has no route) in the site layout — each with the page counter for Fathom beside it. */
export const layout: DefaultLayout = (name) => (name.startsWith('docs/') ? Docs : Site);

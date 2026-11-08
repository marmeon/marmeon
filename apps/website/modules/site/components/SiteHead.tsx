import { Head, usePage } from '@marmeon/react';
import type { ReactNode } from 'react';
import { graphBlock, siteNodes, type GraphNode, type SiteFacts } from '../structured-data.ts';
import { DESCRIPTIONS } from '../descriptions.ts';

/**
 * The head of a page: title, description, canonical URL, Open Graph and the structured data (the website and its organization,
 * and the entities `nodes` builds from the site's facts). `path` is made absolute by the framework against `APP_URL`
 * — never against the request's URL, which may carry a query or a forged host into a cached page.
 * `noindex` keeps the page out of search engines (a release line's pages, whose `path` names the newest page instead).
 * A page without the `site` once-prop (an error page for an unknown path) has no structured data.
 */
export function SiteHead({
  title,
  description,
  path,
  type = 'website',
  noindex = false,
  nodes,
  children,
}: {
  title: string;
  description: string;
  path: string;
  type?: 'website' | 'article';
  noindex?: boolean;
  nodes?: (site: SiteFacts) => GraphNode[];
  children?: ReactNode;
}) {
  const site = usePage().props.site;
  return (
    <Head
      title={title}
      description={description}
      canonical={path}
      robots={noindex ? { index: false } : undefined}
      openGraph={{ title: title || 'Marmeon', description, url: path, type, siteName: 'Marmeon' }}
      jsonLd={site ? graphBlock([...siteNodes(site, DESCRIPTIONS.landing), ...(nodes?.(site) ?? [])]) : undefined}
    >
      {children}
    </Head>
  );
}

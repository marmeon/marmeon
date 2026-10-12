import { Head, usePage } from '@marmeon/react';
import type { ReactNode } from 'react';

/**
 * The head of a page: title, description, canonical URL and Open Graph. The path comes from the page's data and the origin from
 * the shared `site.url` (APP_URL) — never from the request's URL, which may carry a query or a forged host into a cached page.
 */
export function SiteHead({ title, description, path, type = 'website', children }: { title: string; description: string; path: string; type?: 'website' | 'article'; children?: ReactNode }) {
  const site = usePage().props.site;
  const url = site ? new URL(path, site.url).href : undefined;
  return (
    <Head title={title}>
      <meta name="description" content={description} />
      {url && <link rel="canonical" href={url} />}
      {url && <meta property="og:url" content={url} />}
      <meta property="og:title" content={title || 'Marmeon'} />
      <meta property="og:description" content={description} />
      <meta property="og:type" content={type} />
      <meta property="og:site_name" content="Marmeon" />
      {children}
    </Head>
  );
}

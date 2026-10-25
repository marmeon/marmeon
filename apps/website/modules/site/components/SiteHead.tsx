import { Head } from '@marmeon/react';
import type { ReactNode } from 'react';

/**
 * The head of a page: title, description, canonical URL and Open Graph. `path` is made absolute by the framework against `APP_URL`
 * — never against the request's URL, which may carry a query or a forged host into a cached page.
 * `noindex` keeps the page out of search engines (a release line's pages, whose `path` names the newest page instead).
 */
export function SiteHead({ title, description, path, type = 'website', noindex = false, children }: { title: string; description: string; path: string; type?: 'website' | 'article'; noindex?: boolean; children?: ReactNode }) {
  return (
    <Head
      title={title}
      description={description}
      canonical={path}
      robots={noindex ? { index: false } : undefined}
      openGraph={{ title: title || 'Marmeon', description, url: path, type, siteName: 'Marmeon' }}
    >
      {children}
    </Head>
  );
}

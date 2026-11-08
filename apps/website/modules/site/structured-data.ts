import type { JsonLd } from '@marmeon/react';
import { COMPANY_NAME, COMPANY_URL, GITHUB_URL } from './links.ts';

/** What the pages know about the site: from the `site` once-prop. */
export interface SiteFacts {
  /** `https://marmeon.com`: the scheme and host of `APP_URL`, no trailing slash. */
  readonly origin: string;
  readonly version: string;
  /** The SPDX identifier of the framework's license. */
  readonly license: string;
}

type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };
/** One entity of a `@graph`. */
export type GraphNode = { readonly [key: string]: Json };

const NPM_URL = 'https://www.npmjs.com/package/marmeon';

/** The `@id` of an entity of the site: `https://marmeon.com/#website`. */
const idOf = (site: SiteFacts, name: 'website' | 'organization' | 'software' | 'webpage'): string => `${site.origin}/#${name}`;
const ref = (id: string) => ({ '@id': id });

/** The organization behind the site, the operator named in the imprint: its name and URL come from `links.ts`. */
const organization = (site: SiteFacts): GraphNode => ({ '@type': 'Organization', '@id': idOf(site, 'organization'), name: COMPANY_NAME, url: COMPANY_URL });

/**
 * The entities of every page: the website, the organization behind it and the framework as source code, so that every
 * reference of a page resolves in its own graph. No search action: `/docs/search` is closed to crawlers (robots.txt).
 */
export function siteNodes(site: SiteFacts, description: string): GraphNode[] {
  return [
    {
      '@type': 'WebSite',
      '@id': idOf(site, 'website'),
      name: 'Marmeon',
      url: `${site.origin}/`,
      description,
      inLanguage: 'en',
      publisher: ref(idOf(site, 'organization')),
    },
    organization(site),
    {
      '@type': 'SoftwareSourceCode',
      '@id': idOf(site, 'software'),
      name: 'Marmeon',
      description,
      codeRepository: GITHUB_URL,
      sameAs: [NPM_URL],
      programmingLanguage: 'TypeScript',
      runtimePlatform: 'Node.js',
      license: `https://spdx.org/licenses/${site.license}.html`,
      version: site.version,
      author: ref(idOf(site, 'organization')),
      publisher: ref(idOf(site, 'organization')),
    },
  ];
}

/** The landing page: the page about the software. */
export function landingNodes(site: SiteFacts, description: string): GraphNode[] {
  return [
    {
      '@type': 'WebPage',
      '@id': idOf(site, 'webpage'),
      url: `${site.origin}/`,
      name: 'Marmeon',
      description,
      inLanguage: 'en',
      isPartOf: ref(idOf(site, 'website')),
      about: ref(idOf(site, 'software')),
    },
  ];
}

/**
 * A page of the docs: its article and its trail. `path` is the canonical path, `title` the headline; the trail ends at the page and
 * runs through the release line when there is one. `own` is the page's own path (a release line's page differs from the canonical one) and names the entities, `url` stays the canonical.
 */
export function docsNodes(site: SiteFacts, page: { title: string; description: string; path: string; own?: string; version: string; line?: string }): GraphNode[] {
  const url = new URL(page.path, site.origin).href;
  const own = new URL(page.own ?? page.path, site.origin).href;
  const trail: { name: string; item?: string }[] = [
    { name: 'Home', item: `${site.origin}/` },
    { name: 'Docs', item: `${site.origin}/docs` },
    ...(page.line === undefined ? [] : [{ name: page.line, item: `${site.origin}/docs/${page.line}` }]),
    { name: page.title },
  ];
  return [
    {
      '@type': 'TechArticle',
      '@id': `${own}#article`,
      headline: page.title,
      description: page.description,
      url,
      inLanguage: 'en',
      version: page.version,
      isPartOf: ref(idOf(site, 'website')),
      about: ref(idOf(site, 'software')),
      publisher: ref(idOf(site, 'organization')),
    },
    {
      '@type': 'BreadcrumbList',
      '@id': `${own}#breadcrumb`,
      itemListElement: trail.map(({ name, item }, index) => ({ '@type': 'ListItem', position: index + 1, name, ...(item === undefined ? {} : { item }) })),
    },
  ];
}

/**
 * The nodes as one `<Head jsonLd>` block with a `@graph`. `JsonLd` demands an `@type` that a graph does not have, so the type is
 * asserted; the head writes the block like any other (`<` escaped, see docs/seo.md#structured-data).
 */
export function graphBlock(nodes: readonly GraphNode[]): JsonLd {
  return { '@context': 'https://schema.org', '@graph': nodes } as unknown as JsonLd;
}

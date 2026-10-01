import type { RouteManifest, SsrRender } from '@bespokecore/http/page';
import { renderToStaticMarkup, renderToString } from 'react-dom/server';
import { BespokeApp } from './app.tsx';
import { createHeadCollector, defaultTitle, markServerTag, renderHead, type TitleTemplate } from './head.tsx';
import type { ResolvePage } from './pages.ts';

export interface SsrOptions {
  /** The same title template as the client's (`createBespokeApp({ title })`). */
  title?: TitleTemplate;
  /** The same route manifest as the client's (`createBespokeApp({ routes })`), so links render alike. */
  routes?: RouteManifest;
}

/**
 * Builds the app's SSR entry. Lives in `@bespokecore/react/server` so
 * `react-dom/server` never ends up in the client bundle. `<Head>` content is
 * collected while rendering and returned for the document head.
 */
export function createSsrRenderer(resolve: ResolvePage, { title = defaultTitle, routes }: SsrOptions = {}): SsrRender {
  return async (page) => {
    const Component = await resolve(page.component);
    const collector = createHeadCollector();
    const html = renderToString(
      <BespokeApp initialPage={page} initialComponent={Component} resolve={resolve} title={title} routes={routes} headCollector={collector} />,
    );
    return { html, head: renderHead(collector, title, (tag) => renderToStaticMarkup(markServerTag(tag))) };
  };
}

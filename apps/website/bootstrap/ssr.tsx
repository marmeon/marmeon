import { createSsrRenderer } from '@marmeon/react/server';
import type { SsrRender } from '@marmeon/http';
import { routes } from 'virtual:marmeon/routes';
import { fathomScript } from '../modules/site/fathom.ts';
import { title } from './head.ts';
import { layout } from './layouts.ts';
import { resolvePage } from './pages.ts';

const renderPage = createSsrRenderer(resolvePage, { title, routes, layout });

/**
 * The pages, with Fathom's script appended to the head when the document carries a site (`ShareAnalytics`: production with
 * `SITE_FATHOM_SITE` set). A tag written here is not a `<Head>`: the client leaves it alone on hydration and on every visit,
 * so the script loads once per tab.
 */
export const render: SsrRender = async (page, options) => {
  const result = await renderPage(page, options);
  const site = page.props.fathomSite;
  return typeof site === 'string' ? { ...result, head: result.head + fathomScript(site) } : result;
};

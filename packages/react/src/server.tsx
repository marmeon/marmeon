import type { SsrRender } from '@bespokecore/http';
import { renderToString } from 'react-dom/server';
import { BespokeApp } from './app.tsx';
import type { ResolvePage } from './pages.ts';

/**
 * Builds the app's SSR entry. Lives in `@bespokecore/react/server` so
 * `react-dom/server` never ends up in the client bundle.
 */
export function createSsrRenderer(resolve: ResolvePage): SsrRender {
  return async (page) => {
    const Component = await resolve(page.component);
    const html = renderToString(<BespokeApp initialPage={page} initialComponent={Component} resolve={resolve} />);
    return { html };
  };
}

import type { PageObject, RouteManifest, SsrRender } from '@bespokecore/http/page';
import type { MessageLoader } from '@bespokecore/i18n/messages';
import { renderToReadableStream, renderToStaticMarkup } from 'react-dom/server';
import { defaultTitle, isDevelopment, loadPageMessages, type TitleTemplate } from '@bespokecore/http/client';
import { BespokeApp, loadLayerStack } from './app.tsx';
import { SSR_ERROR_DIGEST } from './fallbacks.tsx';
import { createHeadCollector, markServerTag, renderHead, type HeadCollector } from './head.tsx';
import type { LayerFrame } from './layer.tsx';
import type { DefaultLayout, ResolvePage } from './pages.ts';
import { loadView } from './views.ts';
import { ssrResolvers } from './streamed.tsx';

export interface SsrOptions {
  /** The same title template as the client's (`createBespokeApp({ title })`). */
  title?: TitleTemplate;
  /** The same route manifest as the client's (`createBespokeApp({ routes })`), so links render alike. */
  routes?: RouteManifest;
  /** The same default layout as the client's (`createBespokeApp({ layout })`), so the markup matches. */
  layout?: DefaultLayout;
  /**
   * The same language files as the client's (`createBespokeApp({ messages })`). Each page renders with its own
   * `locale`'s messages, loaded before rendering starts — per request, whatever other requests render meanwhile.
   */
  messages?: MessageLoader;
  /** The same layer frame as the client's (`createBespokeApp({ layer })`), so a deep link's layers render alike. */
  layer?: LayerFrame;
}

/**
 * Builds the app's SSR entry. Lives in `@bespokecore/react/server` so `react-dom/server` never ends up in the client
 * bundle. Pages are streamed (`renderToReadableStream`, E37): the promise resolves with the shell — everything outside
 * Suspense boundaries — and its `<Head>` content for the document head; the boundaries follow in the stream as they
 * finish. With `complete` (bots) or `Page.ssr = 'complete'` it resolves once the whole page has rendered;
 * `Page.ssr = false` renders no markup at all (the browser renders the page).
 *
 * An error in the shell rejects (the server then sends the page without markup); an error in a Suspense boundary is
 * reported through `onError`, and the browser renders that boundary when it hydrates.
 */
export function createSsrRenderer(resolve: ResolvePage, { title = defaultTitle, routes, layout, messages, layer }: SsrOptions = {}): SsrRender {
  const head = (collector: HeadCollector) => renderHead(collector, title, (tag) => renderToStaticMarkup(markServerTag(tag)));

  return async (page, { complete = false, onError, onWarning, signal, resolveIsland, resolveDeferred } = {}) => {
    // A deep link's layers (E53) render with the page, in the shell: the layer stack (E71) and their views are loaded first.
    const [Component, catalog] = await Promise.all([
      resolve(page.component),
      loadPageMessages(page, messages),
      ...(page.layers?.length ? [loadLayerStack(), ...page.layers.map((layered) => loadView(resolve, layered.component))] : []),
    ]);
    if (Component.ssr === false) return { html: '', head: head(createHeadCollector()) };
    const whole = complete || Component.ssr === 'complete';
    // Deferred groups stream with the page (E49) — not when it is sent whole: they are computed once the headers are out.
    const streamedProps = !whole && resolveDeferred ? Object.entries(page.deferredProps ?? {}).flatMap(([group, props]) => (props.length > 0 ? [group] : [])) : [];
    const rendered: PageObject = streamedProps.length > 0 ? { ...page, streamedProps } : page;
    // Per render: each island and group is asked once (two identical islands share one request), nothing outlives it.
    const ssr = ssrResolvers(resolveIsland, resolveDeferred);

    const collector = createHeadCollector(
      isDevelopment() && onWarning ? (late) => onWarning(lateHead(page.component, late)) : undefined,
    );
    // Errors React recovers from — a Suspense boundary the browser renders instead — are reported once the shell
    // stands; until then an error may be the shell's own, which rejects the render instead.
    let shellReady = false;
    const recovered: unknown[] = [];
    const stream = await renderToReadableStream(
      <BespokeApp
        initialPage={rendered}
        initialComponent={Component}
        resolve={resolve}
        title={title}
        routes={routes}
        layout={layout}
        headCollector={collector}
        messages={messages}
        initialCatalog={catalog}
        ssr={ssr}
        layer={layer}
      />,
      {
        signal,
        onError(error) {
          // Stopped because the client went away: what did not render is no error.
          if (signal?.aborted) return SSR_ERROR_DIGEST;
          if (shellReady) onError?.(error);
          else recovered.push(error);
          // All the browser learns about it (in production React sends no message): that the server failed here.
          return SSR_ERROR_DIGEST;
        },
      },
    );
    // Islands included: bots and `ssr = 'complete'` pages get every island's markup in the HTML.
    if (whole) await stream.allReady;
    shellReady = true;
    for (const error of recovered) onError?.(error);
    // What streams in from here on comes after the document head.
    collector.sealed = true;
    return { html: stream, head: head(collector), ...(streamedProps.length > 0 ? { streamedProps } : {}) };
  };
}

function lateHead(component: string, title: string | undefined): string {
  const what = title === undefined ? 'A <Head>' : `<Head title="${title}">`;
  return (
    `${what} in [${component}] rendered after the document head was sent: it is inside a Suspense boundary that was ` +
    "still loading when the shell streamed, so the server's HTML misses it (the browser adds it once it hydrates; " +
    "bots don't wait for that). Move it out of the Suspense boundary, or set the page's ssr = 'complete'."
  );
}

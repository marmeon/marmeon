import type { RouteManifest, SsrRender } from '@marmeon/http/page';
import type { PageObject } from '@marmeon/http/protocol';
import type { MessageLoader } from '@marmeon/i18n/messages';
import { cloneElement, type ReactElement } from 'react';
import { renderToReadableStream, renderToStaticMarkup } from 'react-dom/server';
import { defaultTitle, loadPageMessages } from '@marmeon/http/client/adapter';
import { isDevelopment, type TitleTemplate } from '@marmeon/http/client';
import { MarmeonApp, loadLayerStack } from './app.tsx';
import { SSR_ERROR_DIGEST } from './fallbacks.tsx';
import { createHeadCollector, markServerTag, renderHead, type HeadCollector } from './head.tsx';
import type { LayerFrame } from './layer.tsx';
import { viewName, type DefaultLayout, type ResolvePage } from './pages.ts';
import { loadView } from './views.ts';
import { ssrResolvers } from './streamed.tsx';

export interface SsrOptions {
  /** The same title template as the client's (`createMarmeonApp({ title })`). */
  title?: TitleTemplate;
  /** The same route manifest as the client's (`createMarmeonApp({ routes })`), so links render alike. */
  routes?: RouteManifest;
  /** The same default layout as the client's (`createMarmeonApp({ layout })`), so the markup matches. */
  layout?: DefaultLayout;
  /**
   * The same language files as the client's (`createMarmeonApp({ messages })`). Each page renders with its own
   * `locale`'s messages, loaded before rendering starts — per request, whatever other requests render meanwhile.
   */
  messages?: MessageLoader;
  /** The same layer frame as the client's (`createMarmeonApp({ layer })`), so a deep link's layers render alike. */
  layer?: LayerFrame;
}

/**
 * Builds the app's SSR entry. Lives in `@marmeon/react/server` so `react-dom/server` never ends up in the client
 * bundle. Pages stream: the promise resolves with the shell and its `<Head>` content, the Suspense boundaries follow.
 * An error in the shell rejects (the server then sends the page without markup); an error in a boundary is reported
 * through `onError`, and the browser renders that boundary. See docs/pages.md#server-rendering.
 */
export function createSsrRenderer(resolve: ResolvePage, { title = defaultTitle, routes, layout, messages, layer }: SsrOptions = {}): SsrRender {
  // A `<Head>`'s script or style carries the response's CSP nonce — the rest of its tags need none.
  const head = (collector: HeadCollector, nonce?: string, urls?: { appUrl?: string; warn?: (message: string) => void }) =>
    renderHead(collector, title, (tag) => renderToStaticMarkup(markServerTag(nonce ? withNonce(tag, nonce) : tag)), { ...urls, nonce });

  return async (page, { complete = false, onError, onWarning, signal, resolveIsland, resolveDeferred, nonce, placeholder, appUrl } = {}) => {
    const urls = { ...(appUrl ? { appUrl } : {}), ...(isDevelopment() && onWarning ? { warn: onWarning } : {}) };
    // A deep link's layers render with the page, in the shell: the layer stack and their views are loaded first.
    const [Component, catalog] = await Promise.all([
      resolve(viewName(resolve, page.component, page.props)),
      loadPageMessages(page, messages),
      ...(page.layers?.length ? [loadLayerStack(), ...page.layers.map((layered) => loadView(resolve, layered.component))] : []),
    ]);
    if (placeholder !== undefined && !Component.placeholder) {
      throw new Error(`[${page.component}] has no placeholder: set \`${fileViewName(page.component)}.placeholder = …\` on the view (see docs/navigation.md#instant-visits).`);
    }
    if (Component.ssr === false && placeholder === undefined) return { html: '', head: head(createHeadCollector(), nonce, urls) };
    const whole = complete || placeholder !== undefined || Component.ssr === 'complete';
    // Deferred groups stream with the page — not when it is sent whole: they are computed once the headers are out.
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
      <MarmeonApp
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
        initialPlaceholder={placeholder}
      />,
      {
        signal,
        // React's inline scripts (`$RC` reveals a Suspense boundary) and its `<style precedence>` tags, under a strict CSP.
        ...(nonce ? { nonce: { script: nonce, style: nonce } } : {}),
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
    return { html: stream, head: head(collector, nonce, urls), ...(streamedProps.length > 0 ? { streamedProps } : {}) };
  };
}

/** A `<script>` or `<style>` of a `<Head>` with the response's CSP nonce; other tags as they are. */
function withNonce(tag: ReactElement, nonce: string): ReactElement {
  return tag.type === 'script' || tag.type === 'style' ? cloneElement(tag, { nonce } as Record<string, string>) : tag;
}

/** `user-profile/Show` → `Show`: how the view is usually named in its file. */
function fileViewName(component: string): string {
  return component.slice(component.lastIndexOf('/') + 1);
}

function lateHead(component: string, title: string | undefined): string {
  const what = title === undefined ? 'A <Head>' : `<Head title="${title}">`;
  return (
    `${what} in [${component}] rendered after the document head was sent: it is inside a Suspense boundary that was ` +
    "still loading when the shell streamed, so the server's HTML misses it (the browser adds it once it hydrates; " +
    "bots don't wait for that). Move it out of the Suspense boundary, or set the page's ssr = 'complete'."
  );
}

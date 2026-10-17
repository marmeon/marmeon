// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://app.test/users/1/edit" }
import type { RouteManifest } from '@marmeon/http/page';
import { PAGE_HEADER, type PageObject, PROTOCOL_VERSION } from '@marmeon/http/protocol';
import type { VisitException } from '@marmeon/http/client';
import { loadHistoryFallback } from '@marmeon/http/client/adapter';
import { act, type CSSProperties } from 'react';
import { createRoot, hydrateRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup, renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarmeonApp, loadLayerStack } from './app.tsx';
import { ConfirmDialog } from './confirm.tsx';
import { ErrorPage } from './error-page.tsx';
import { VisitFailure } from './fallbacks.tsx';
import { ServerFailure } from './failure.tsx';
import { LayerDialog } from './layer-dialog.tsx';
import type { LayerFrameProps } from './layer.tsx';
import { resolveModulePages, type PageComponent } from './pages.ts';
import { loadView } from './views.ts';

/*
 * The framework renders no `style` attribute — a strict `style-src` (without 'unsafe-inline') blocks every one, and nonces
 * do not cover attributes. The look comes from `@marmeon/react/styles.css` (classes); `LayerDialog`'s `style` prop is written
 * through the CSSOM once mounted, which no policy blocks.
 */

const HISTORY = [await loadHistoryFallback()];
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Every tag of `html` with a style attribute. */
const styled = (html: string) => html.match(/<[^>]+\sstyle="[^>]*>/g) ?? [];

function Profile() {
  return <main>Ada</main>;
}

function Edit() {
  return (
    <section>
      <h2>Edit</h2>
      <input data-testid="field" />
    </section>
  );
}

const pages: Record<string, PageComponent> = { Profile, Edit };
const resolve = resolveModulePages(Object.fromEntries(Object.entries(pages).map(([name, page]) => [`/modules/app/views/${name}.tsx`, async () => ({ default: page })])));
const routes: RouteManifest = {};
const page = (name: string, url: string): PageObject => ({ component: `app/${name}`, props: {}, url, version: null });
/** A deep link to the edit layer over the profile. */
const deepLink = (): PageObject => ({ ...page('Profile', '/users/1'), layers: [{ ...page('Edit', '/users/1/edit'), layer: { key: 'app/Edit', base: '/users/1' } }] });

const WIDE: CSSProperties = { maxWidth: 480, borderTop: '4px solid rebeccapurple' };
/** An app's frame: the default dialog with a few inline properties of its own. */
const WideFrame = (props: LayerFrameProps) => <LayerDialog {...props} className="app-layer" style={WIDE} />;

let root: Root | undefined;
let container: HTMLElement;

beforeEach(() => {
  history.replaceState(null, '', '/users/1/edit');
  container = document.createElement('div');
  document.body.replaceChildren(container);
  vi.spyOn(window, 'fetch').mockImplementation(async () => new Response(JSON.stringify(page('Profile', '/users/1')), { headers: { [PAGE_HEADER]: PROTOCOL_VERSION } }));
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  vi.restoreAllMocks();
});

/** What the server renders for the deep link — the stack and the layer's view loaded first, as the SSR entry does. */
async function serverRender(frame?: typeof WideFrame): Promise<{ html: string; Component: PageComponent }> {
  const Component = await resolve('app/Profile');
  await Promise.all([loadLayerStack(), loadView(resolve, 'app/Edit')]);
  const html = renderToString(<MarmeonApp features={HISTORY} initialPage={deepLink()} initialComponent={Component} resolve={resolve} routes={routes} {...(frame ? { layer: frame } : {})} />);
  return { html, Component };
}

describe('LayerDialog renders no style attribute', () => {
  it('on the server: a deep link’s dialog, its content box and close button carry classes of styles.css — no style, not even the app’s', async () => {
    for (const frame of [undefined, WideFrame]) {
      const { html } = await serverRender(frame);
      expect(html).toContain('data-marmeon-layer="app/Edit"');
      expect(styled(html), `inline styles in the server’s markup — ${styled(html).join(' ')}`).toEqual([]);
      expect(html).toMatch(/<dialog[^>]* class="marmeon-layer marmeon-layer--modal( app-layer)?"/);
      expect(html).toContain('class="marmeon-layer__content"');
      expect(html).toContain('class="marmeon-layer__close"');
    }
  });

  it('after hydrating: the app’s style prop is on the dialog — written through the CSSOM, no mismatch reported', async () => {
    const { html, Component } = await serverRender(WideFrame);
    container.innerHTML = html;
    const recoverable = vi.fn();
    await act(async () => {
      root = hydrateRoot(container, <MarmeonApp features={HISTORY} initialPage={deepLink()} initialComponent={Component} resolve={resolve} routes={routes} layer={WideFrame} />, {
        onRecoverableError: recoverable,
      });
    });
    const dialog = container.querySelector<HTMLDialogElement>('dialog[data-marmeon-layer]')!;
    expect(dialog.style.maxWidth, 'the style prop after the mount').toBe('480px');
    expect(dialog.style.borderTop).toContain('rebeccapurple');
    expect(dialog.className).toBe('marmeon-layer marmeon-layer--modal app-layer');
    expect(recoverable).not.toHaveBeenCalled();
  });

  it('a layer opened in the browser gets its style prop at once, before it paints', async () => {
    const layer = { key: 'app/Edit', depth: 1, close: async () => {} } as unknown as LayerFrameProps['layer'];
    root = createRoot(container);
    await act(async () => root!.render(<LayerDialog layer={layer} variant="slideover" style={WIDE}><h2>Edit</h2></LayerDialog>));
    const dialog = container.querySelector('dialog')!;
    expect(dialog.className).toBe('marmeon-layer marmeon-layer--slideover');
    expect(dialog.style.maxWidth).toBe('480px');
  });
});

describe('the failure dialogs, the error page and the confirmation dialog render no style attribute', () => {
  type Server = Extract<VisitException, { type: 'server' }>;
  const servers: Server[] = [
    { type: 'server', status: 502, page: undefined, html: '<h1>Bad gateway</h1>' } as Server,
    { type: 'server', status: 500, page: undefined, html: undefined } as Server,
  ];

  it('the notice of an unreachable server — classes of styles.css, in the first download', () => {
    const html = renderToStaticMarkup(<VisitFailure failure={{ type: 'network' } as VisitException} resolve={resolve} onDismiss={() => {}} />);
    expect(html).toContain('class="marmeon-failure marmeon-failure--network"');
    expect(styled(html), styled(html).join(' ')).toEqual([]);
  });

  it.each(servers.map((failure) => [failure.html ? 'with the HTML of a proxy' : 'without a page', failure] as const))('the server’s error (%s) — classes of styles.css', (_kind, failure) => {
    const html = renderToStaticMarkup(<ServerFailure failure={failure} resolve={resolve} onDismiss={() => {}} />);
    expect(html).toContain('class="marmeon-failure marmeon-failure--server"');
    expect(styled(html), styled(html).join(' ')).toEqual([]);
  });

  it('the built-in error page — with the exception (development) too', () => {
    const html = renderToStaticMarkup(<ErrorPage status={500} title="Server Error" message="boom" exception={{ name: 'Error', message: 'boom', stack: 'Error: boom' }} />);
    expect(html).toContain('<main class="marmeon-error">');
    expect(html).toContain('<pre class="marmeon-error__exception">');
    expect(styled(html), styled(html).join(' ')).toEqual([]);
  });

  it('ConfirmDialog — its look is classes, an app’s class is added to them', () => {
    const html = renderToStaticMarkup(<ConfirmDialog request={{ kind: 'confirm', message: 'Sure?', prompt: 'delete' }} answer={() => {}} className="app-confirm" />);
    expect(html).toContain('class="marmeon-confirm app-confirm"');
    expect(styled(html), styled(html).join(' ')).toEqual([]);
  });
});

// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://app.test/" }
import { PAGE_SCRIPT_ID, type PageObject } from '@marmeon/http/protocol';
import { createMessageLoader } from '@marmeon/i18n/messages';
import { act } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadLayerStack, MarmeonApp } from './app.tsx';
import { createMarmeonApp } from './client.tsx';
import { useLocale } from './i18n.tsx';
import { resolveModulePages } from './pages.ts';
import { loadView } from './views.ts';
import { createSsrRenderer } from './server.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const instant = '2026-10-14T05:00:00Z';

/** Prints an instant without a zone of its own — the app's zone decides. */
function Opening() {
  const { format } = useLocale();
  return <time>{format.date(instant, { dateStyle: 'medium', timeStyle: 'short' })}</time>;
}

const resolve = resolveModulePages({
  '/modules/shop/views/Opening.tsx': async () => ({ default: Opening }),
  '/modules/shop/views/Door.tsx': async () => ({ default: Opening }),
});
const messages = createMessageLoader({});

const page = (timeZone?: string): PageObject => ({ component: 'shop/Opening', props: {}, url: '/', version: null, locale: 'en', ...(timeZone ? { timeZone } : {}) });

/** Runs `run` with another process zone: the server and the browser of a real app sit in zones the app does not choose. */
async function inProcessZone<T>(zone: string, run: () => Promise<T>): Promise<T> {
  const before = process.env.TZ;
  process.env.TZ = zone;
  try {
    return await run();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}

async function serverMarkup(sent: PageObject): Promise<string> {
  return new Response((await createSsrRenderer(resolve, { messages })(sent, { complete: true })).html).text();
}

async function browser(sent: PageObject, markup: string): Promise<string | undefined> {
  document.head.innerHTML = `<script type="application/json" id="${PAGE_SCRIPT_ID}">${JSON.stringify(sent)}</script>`;
  document.body.innerHTML = `<div id="app">${markup}</div>`;
  await act(async () => {
    await createMarmeonApp({ resolve, messages });
    await new Promise((done) => setTimeout(done, 20));
  });
  return document.querySelector('time')?.textContent ?? undefined;
}

const reported = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter(([message]) => !String(message).includes('multiple renderers'));

afterEach(() => vi.restoreAllMocks());

describe('the app time zone in the page', () => {
  it('renders the same instant on the server and in the browser — whatever zone either process sits in', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sent = page('America/Los_Angeles');
    const markup = await inProcessZone('Pacific/Kiritimati', () => serverMarkup(sent));
    expect(markup.replaceAll(' ', ' ')).toContain('Oct 13, 2026, 10:00 PM');
    const shown = await inProcessZone('Asia/Tokyo', () => browser(sent, markup));
    expect(shown?.replaceAll(' ', ' ')).toBe('Oct 13, 2026, 10:00 PM');
    expect(reported(errors)).toEqual([]);
    expect(document.querySelector('[data-marmeon-hydration]')).toBeNull();
  });

  it('shows the visitor’s own zone when the page names none — as before', async () => {
    const markup = await inProcessZone('Asia/Tokyo', () => serverMarkup(page()));
    expect(markup.replaceAll(' ', ' ')).toContain('Oct 14, 2026, 2:00 PM');
  });
});

describe('the app time zone in a layer', () => {
  it('is the zone of the layer’s own page, the messages and locale those of the page beneath', async () => {
    const catalog = await createMessageLoader({}).load('en');
    const layer: PageObject = { ...page('Asia/Tokyo'), component: 'shop/Door', url: '/door', layer: { key: 'shop/Door', base: '/' } };
    const document: PageObject = { ...page('America/Los_Angeles'), layers: [layer] };
    await Promise.all([loadLayerStack(), loadView(resolve, 'shop/Door')]);
    const Base = (await resolve('shop/Opening')) as never;
    const html = renderToString(<MarmeonApp initialPage={document} initialComponent={Base} resolve={resolve} messages={messages} initialCatalog={catalog} />).replaceAll('\u202f', ' ');
    expect(html).toContain('Oct 13, 2026, 10:00 PM'); // the page: Los Angeles
    expect(html).toContain('Oct 14, 2026, 2:00 PM'); // its layer: Tokyo
  });
});

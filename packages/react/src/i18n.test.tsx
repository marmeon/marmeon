// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://app.test/a" }
import { loadPageMessages } from '@bespokecore/http/client';
import { PAGE_HEADER, type PageObject } from '@bespokecore/http/page';
import { createMessageLoader } from '@bespokecore/i18n/messages';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BespokeApp, useRouter } from './app.tsx';
import { useLocale, useTranslation } from './i18n.tsx';
import { resolveModulePages, type PageComponent } from './pages.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Greeting({ name }: { name: string }) {
  const t = useTranslation('shop');
  const { visit } = useRouter();
  const { format } = useLocale();
  return (
    <p data-page="greeting">
      {t('greeting' as never, { name } as never)} · {format.number(1234.5)}
      <button data-testid="next" onClick={() => void visit('/b')} />
    </p>
  );
}

const pages: Record<string, PageComponent> = { Greeting };
const resolve = resolveModulePages({ '../modules/app/views/Greeting.tsx': async () => ({ default: Greeting }) });
const page = (url: string, locale: string): PageObject => ({ component: 'app/Greeting', props: { name: 'Ada' }, url, version: null, locale });

const loads: string[] = [];
const file = (path: string, messages: object) => [path, async () => (loads.push(path), { default: messages })] as const;
const lang = Object.fromEntries([
  file('/modules/shop/lang/en.ts', { greeting: 'Hello {name}' }),
  file('/modules/shop/lang/de.ts', { greeting: 'Hallo {name}' }),
]);

let root: Root;
let container: HTMLElement;
beforeEach(() => {
  loads.length = 0;
  history.replaceState(null, '', '/a');
  document.documentElement.lang = 'en';
  container = document.createElement('div');
  document.body.replaceChildren(container);
  vi.spyOn(window, 'fetch').mockImplementation(async () => new Response(JSON.stringify(page('/b', 'de')), { headers: { [PAGE_HEADER]: 'true' } }));
});
afterEach(async () => {
  await act(async () => root?.unmount());
  vi.restoreAllMocks();
});

describe('useTranslation', () => {
  it('renders with the messages of the page’s locale — a page in another language loads that language first', async () => {
    const messages = createMessageLoader(lang, { fallback: 'en' });
    const first = page('/a', 'en');
    const catalog = await loadPageMessages(first, messages);
    root = createRoot(container);
    await act(async () => root.render(<BespokeApp initialPage={first} initialComponent={pages.Greeting!} resolve={resolve} progress={false} messages={messages} initialCatalog={catalog} />));
    expect(container.textContent).toBe('Hello Ada · 1,234.5');
    expect(loads).toEqual(['/modules/shop/lang/en.ts']);

    // Another tab switched the language: the next page comes in German.
    await act(async () => (container.querySelector('[data-testid="next"]') as HTMLButtonElement).click());
    await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 10))));
    expect(container.textContent).toBe('Hallo Ada · 1.234,5');
    expect(document.documentElement.lang).toBe('de');
    expect(loads).toEqual(['/modules/shop/lang/en.ts', '/modules/shop/lang/de.ts']);

    // Back: the page in memory is in its own language — each page renders as one, never mixed.
    await act(async () => history.back());
    await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 10))));
    expect(container.textContent).toBe('Hello Ada · 1,234.5');
    expect(document.documentElement.lang).toBe('en');
  });

  it('tells what is missing without the app’s messages', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => renderToString(<BespokeApp initialPage={page('/a', 'en')} initialComponent={pages.Greeting!} resolve={resolve} />)).toThrow(
      /useTranslation\(\) needs the app's messages: createBespokeApp\(\{ messages \}\) and createSsrRenderer\(resolve, \{ messages \}\)/,
    );
  });
});

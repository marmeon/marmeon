// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { START } from '../components/start-pages.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The layer is the client's: a document always renders the page. So the view is rendered here with the framework's hooks stubbed.
const state = vi.hoisted(() => ({ isLayer: false, query: { q: 'routing', scope: 'all' } as { q: string; scope: string }, setQuery: vi.fn() }));
vi.mock('@marmeon/react', async () => {
  const { createElement } = await import('react');
  return {
    Head: () => null,
    Link: ({ children, href, prefetch: _prefetch, ...rest }: Record<string, unknown> & { children?: never; href?: string; prefetch?: boolean }) => createElement('a', { href, ...rest }, children),
    useLayer: () => ({ isLayer: state.isLayer }),
    usePage: () => ({ props: { site: { version: '1.1.0' } } }),
    useQueryState: () => [state.query, state.setQuery],
    useRoute: () => () => '/docs/search',
    LayerDialog: () => null,
  };
});

const { default: Search } = await import('./Search.tsx');
type Results = ComponentProps<typeof Search>['results'];

const hit = (name: string) => ({ href: `/docs/${name}#x`, page: name, section: 'The Basics', heading: `${name} heading`, excerpt: `about ${name}` });
const FOUND: Results = { q: 'routing', scope: 'all', pages: [{ href: '/docs/routing', page: 'Routing', section: 'The Basics' }], sections: [hit('one'), hit('two')] };
const none = (q = 'routing', scope: 'all' | 'pages' | 'sections' = 'all'): Results => ({ q, scope, pages: [], sections: [] });
const props = (results: Results) => ({ results }) as unknown as ComponentProps<typeof Search>;
const render = (results: Results = FOUND) => renderToString(createElement(Search, props(results)));

beforeEach(() => {
  state.isLayer = false;
  state.query = { q: 'routing', scope: 'all' };
  state.setQuery.mockReset();
});

describe('the search view, as the server sends it', () => {
  it('is a page with an h1, a submit button, the three scopes as radios and no ARIA widget', () => {
    const html = render();
    expect(html).toContain('<h1 class="visually-hidden">Search</h1>');
    expect(html).toContain('type="submit"');
    expect(html.match(/type="radio"/g)).toHaveLength(3);
    expect(html).toContain('checked=""');
    expect(html).not.toMatch(/role="(?:combobox|listbox|option|group)"/);
    expect(html).not.toContain('aria-activedescendant');
    expect(html).not.toContain('style=');
  });

  it('is a layer with a hidden h2 and no submit button — the results are live', () => {
    state.isLayer = true;
    const html = render();
    expect(html).toContain('<h2 class="visually-hidden">Search</h2>');
    expect(html).not.toContain('<h1');
    expect(html).not.toContain('type="submit"');
    expect(html).not.toContain('style=');
  });

  it('is a GET form to the search with the three scopes as radios, the current one the only one checked', () => {
    state.query = { q: 'routing', scope: 'pages' };
    const html = render({ ...FOUND, scope: 'pages', sections: [] });
    expect(html).toMatch(/<form class="search-form" role="search" action="\/docs\/search" method="get"/);
    const radios = [...html.matchAll(/<input [^>]*type="radio"[^>]*>/g)].map((match) => match[0]);
    expect(radios.map((radio) => /value="([^"]*)"/.exec(radio)![1])).toEqual(['all', 'pages', 'sections']);
    for (const radio of radios) expect(radio).toContain('name="scope"');
    expect(radios.filter((radio) => radio.includes('checked=""')).map((radio) => /value="([^"]*)"/.exec(radio)![1])).toEqual(['pages']);
    expect(html).toContain('>Pages<');
    expect(html).not.toContain('On a page');
  });

  it('lists the pages and then the sections as plain links, and counts them', () => {
    const html = render();
    expect(html.indexOf('>Pages<')).toBeLessThan(html.indexOf('>On a page<'));
    expect(html).toContain('href="/docs/routing"');
    expect(html).toContain('3 results');
    expect(render({ ...FOUND, pages: [], sections: [hit('one')] })).toContain('1 result<');
  });

  it('lists the start pages, one link each and in order, for an empty query', () => {
    state.query = { q: '', scope: 'all' };
    const html = render(none(''));
    expect(html).toContain('Where to start');
    expect(html).toContain('Type to search');
    const group = html.slice(html.indexOf('Where to start'), html.indexOf('</section>', html.indexOf('Where to start')));
    expect([...group.matchAll(/<a [^>]*href="([^"]*)"/g)].map((match) => match[1])).toEqual(START.map((page) => page.path));
  });

  it('says that nothing was found for the query the list answers', () => {
    state.query = { q: 'zzz', scope: 'all' };
    const html = render(none('zzz'));
    expect(html).toContain('Nothing found for “zzz”.');
    expect(html).toContain('role="status"');
  });
});

describe('the search view, hydrated: a combobox over the results', () => {
  let container: HTMLDivElement;
  let root: Root;
  let clicked: string[];

  const field = () => container.querySelector<HTMLInputElement>('input[data-search-field]')!;
  const options = () => [...container.querySelectorAll<HTMLElement>('[role="option"]')];
  const press = (key: string, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    act(() => void field().dispatchEvent(event));
    return event.defaultPrevented;
  };
  const activeIndex = () => options().findIndex((option) => option.id === field().getAttribute('aria-activedescendant'));
  const mount = (results: Results) => act(() => root.render(createElement(Search, props(results))));

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    clicked = [];
    container.addEventListener('click', (event) => {
      event.preventDefault(); // happy-dom would navigate
      clicked.push((event.target as HTMLElement).closest('a')?.getAttribute('href') ?? '');
    });
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('the field is a combobox that names the first option as active', () => {
    mount(FOUND);
    expect(field().getAttribute('role')).toBe('combobox');
    const listbox = container.querySelector('[role="listbox"]')!;
    expect(field().getAttribute('aria-controls')).toBe(listbox.id);
    expect(field().getAttribute('aria-expanded')).toBe('true');
    expect(field().getAttribute('aria-autocomplete')).toBe('list');
    expect(listbox.id).not.toBe('');
    expect(options()).toHaveLength(3);
    expect(activeIndex()).toBe(0);
    expect(options()[0]!.getAttribute('aria-selected')).toBe('true');
    expect(options()[1]!.getAttribute('aria-selected')).toBe('false');
    expect(container.innerHTML).not.toContain('style=');
  });

  it('↓ moves on and stops at the last, ↑ stops at the first, End and Home jump', () => {
    mount(FOUND);
    press('ArrowDown');
    expect(activeIndex()).toBe(1);
    press('ArrowDown');
    press('ArrowDown');
    expect(activeIndex()).toBe(2);
    press('Home');
    expect(activeIndex()).toBe(0);
    press('ArrowUp');
    expect(activeIndex()).toBe(0);
    press('End');
    expect(activeIndex()).toBe(2);
  });

  it('↵ clicks the active option — the same path as a mouse click', () => {
    mount(FOUND);
    press('ArrowDown');
    press('Enter');
    expect(clicked).toEqual(['/docs/one#x']);
  });

  it('a changed result list starts at the first option again', () => {
    mount(FOUND);
    press('End');
    expect(activeIndex()).toBe(2);
    mount({ ...FOUND, pages: [], sections: [hit('three'), hit('four')] });
    expect(options()).toHaveLength(2);
    expect(activeIndex()).toBe(0);
  });

  it('moving the mouse over an option selects it', () => {
    mount(FOUND);
    act(() => void options()[2]!.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })));
    expect(activeIndex()).toBe(2);
  });

  it('changing a scope sets the query state', () => {
    mount(FOUND);
    act(() => void container.querySelector<HTMLInputElement>('input[value="pages"]')!.click());
    expect(state.setQuery).toHaveBeenCalledWith({ scope: 'pages' });
  });

  it('without results the field names no active option and ↵ does nothing', () => {
    state.query = { q: 'zzz', scope: 'all' };
    mount(none('zzz'));
    expect(field().getAttribute('aria-expanded')).toBe('false');
    expect(field().hasAttribute('aria-activedescendant')).toBe(false);
    const errors: unknown[] = [];
    const record = (event: ErrorEvent) => errors.push(event.error);
    window.addEventListener('error', record);
    expect(press('Enter')).toBe(false);
    expect(press('ArrowDown')).toBe(false);
    window.removeEventListener('error', record);
    expect(clicked).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('prevents the default of the keys it handles and of no other', () => {
    mount(FOUND);
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter']) expect(press(key), key).toBe(true);
    expect(press('a')).toBe(false);
  });

  it('↵ while an IME composes opens nothing', () => {
    mount(FOUND);
    expect(press('Enter', { isComposing: true })).toBe(false);
    expect(clicked).toEqual([]);
  });

  it('a list of the same length with other hits starts at the first option again', () => {
    mount(FOUND);
    press('End');
    expect(activeIndex()).toBe(2);
    mount({ ...FOUND, pages: [{ href: '/docs/cache', page: 'Cache', section: 'Digging Deeper' }], sections: [hit('five'), hit('six')] });
    expect(options()).toHaveLength(3);
    expect(activeIndex()).toBe(0);
  });

  it('lists the start pages as options, one per entry and in order', () => {
    state.query = { q: '', scope: 'all' };
    mount(none(''));
    expect(options().map((option) => option.getAttribute('href'))).toEqual(START.map((page) => page.path));
  });

  it('while the list is the previous query’s, ↵ opens nothing and nothing is said about the new query', () => {
    state.query = { q: 'queue', scope: 'all' }; // typed: the answer for “routing” is still the list
    mount(FOUND);
    expect(press('Enter')).toBe(true);
    expect(clicked).toEqual([]);
    expect(field().hasAttribute('aria-activedescendant')).toBe(false);
    expect(options().filter((option) => option.getAttribute('aria-selected') === 'true')).toEqual([]);
    expect(container.textContent).toContain('Searching…');
    expect(container.textContent).not.toMatch(/Nothing found|\d+ results?/);
    // The same for a scope changed before its answer, with no hit at all.
    state.query = { q: 'zzz', scope: 'pages' };
    mount(none('routing', 'all'));
    expect(container.textContent).not.toContain('Nothing found');
    expect(container.textContent).toContain('Searching…');
  });

  it('a scope changed before its answer is pending too: ↵ opens nothing', () => {
    state.query = { q: 'routing', scope: 'pages' };
    mount(FOUND); // the answer is for scope all
    expect(press('Enter')).toBe(true);
    expect(clicked).toEqual([]);
    expect(field().hasAttribute('aria-activedescendant')).toBe(false);
    expect(container.textContent).toContain('Searching…');
  });

  it('the first keystroke keeps Where to start on screen under “Searching…”', () => {
    state.query = { q: 'r', scope: 'all' };
    mount(none(''));
    expect(container.textContent).toContain('Where to start');
    expect(container.textContent).toContain('Searching…');
    expect(container.textContent).not.toContain('Type to search');
    expect(press('Enter')).toBe(true);
    expect(clicked).toEqual([]);
  });

  it('a cleared field keeps the previous list on screen under “Searching…”', () => {
    state.query = { q: '', scope: 'all' };
    mount(FOUND);
    expect(options()).toHaveLength(3);
    expect(container.textContent).toContain('Searching…');
    expect(container.textContent).not.toContain('Where to start');
    press('Enter');
    expect(clicked).toEqual([]);
  });

  it('opens the hit once the answer is for the field’s text', () => {
    state.query = { q: ' routing ', scope: 'all' }; // the answer is for the trimmed text
    mount(FOUND);
    press('Enter');
    expect(clicked).toEqual(['/docs/routing']);
  });

  it('names its own ids, so a heading of the page under the layer cannot take them', () => {
    const heading = document.createElement('h2');
    heading.id = 'search-results';
    document.body.append(heading);
    mount(FOUND);
    const ids = [...container.querySelectorAll('[id]')].map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain('search-results');
    expect(ids.filter((id) => id.includes('-option-'))).toHaveLength(3);
    expect(container.querySelector('label')!.getAttribute('for')).toBe(field().id);
    press('Enter');
    expect(clicked).toEqual(['/docs/routing']);
    heading.remove();
  });
});

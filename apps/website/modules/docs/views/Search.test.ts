import { createElement, type ComponentProps } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The layer is the client's: a document always renders the page. So the view is rendered here with the framework's hooks stubbed.
const state = vi.hoisted(() => ({ isLayer: false }));
vi.mock('@marmeon/react', async () => {
  const { createElement } = await import('react');
  return {
    Head: () => null,
    Link: ({ children, href }: { children?: never; href?: string }) => createElement('a', { href }, children),
    useLayer: () => ({ isLayer: state.isLayer }),
    useQueryState: () => [{ q: 'routing' }, () => undefined],
    useRoute: () => () => '/docs/search',
    LayerDialog: () => null,
  };
});

const { default: Search } = await import('./Search.tsx');
const render = () => renderToString(createElement(Search, { results: [] } as unknown as ComponentProps<typeof Search>));

describe('the search view', () => {
  beforeEach(() => {
    state.isLayer = false;
  });

  it('is a page with an h1 and a submit button', () => {
    const html = render();
    expect(html).toContain('<h1 class="visually-hidden">Search</h1>');
    expect(html).toContain('type="submit"');
  });

  it('is a layer with a hidden h2 and no submit button — the results are live', () => {
    state.isLayer = true;
    const html = render();
    expect(html).toContain('<h2 class="visually-hidden">Search</h2>');
    expect(html).not.toContain('<h1');
    expect(html).not.toContain('type="submit"');
  });
});

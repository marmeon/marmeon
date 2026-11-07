// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Editor } from './Editor.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const files = [
  { name: 'ShowController.ts', html: '<pre class="code"><span class="tk">export</span> first</pre>' },
  { name: 'Show.tsx', html: '<pre class="code"><span class="tk">import</span> second</pre>' },
];

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.replaceChildren(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
});

describe('Editor without JavaScript', () => {
  it('shows one file with its name and code, and no tablist', () => {
    const html = renderToString(<Editor label="Controller" files={[files[0]!]} />);
    expect(html).toContain('ShowController.ts');
    expect(html).toContain('export</span> first');
    expect(html).not.toContain('role="tablist"');
  });

  it('shows both names and both codes of the tabs layout', () => {
    const html = renderToString(<Editor label="Pair" files={files} />);
    for (const text of ['ShowController.ts', 'Show.tsx', 'first', 'second']) expect(html).toContain(text);
    expect(html).not.toContain('role="tablist"');
  });

  it('shows the footer under the code', () => {
    expect(renderToString(<Editor label="Pair" files={files} footer={<p>compile error</p>} />)).toMatch(/second.*editor-footer.*compile error/s);
  });

  it('names the files with headings of the given level in every layout', () => {
    expect(renderToString(<Editor label="Pair" files={files} layout="split" />)).toContain('<h4 class="editor-name">Show.tsx</h4>');
    expect(renderToString(<Editor label="Pair" files={[files[0]!]} headingLevel={3} />)).toContain('<h3 class="editor-name">ShowController.ts</h3>');
    expect(renderToString(<Editor label="Pair" files={files} />)).toContain('<h4 class="tabs-heading">Show.tsx</h4>');
  });

  it('names the files with plain text when the level is null', () => {
    const html = renderToString(<Editor label="Pair" files={files} layout="split" headingLevel={null} />);
    expect(html).toContain('<p class="editor-name">Show.tsx</p>');
    expect(html).not.toMatch(/<h[1-6]/);
  });

  it('does not accept a null level for the tabs layout', () => {
    // @ts-expect-error file tabs stack under headings without JavaScript, so they need a level
    renderToString(<Editor label="Pair" files={files} headingLevel={null} />);
  });

  it('sets no style attribute', () => {
    expect(renderToString(<Editor label="Pair" files={files} footer="x" />)).not.toContain('style=');
  });
});

describe('Editor with JavaScript', () => {
  it('turns two files into a tablist with two tabs', async () => {
    await act(async () => root.render(<Editor label="Pair" files={files} />));
    expect([...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual(['ShowController.ts', 'Show.tsx']);
    expect(container.querySelector('[style]')).toBeNull();
  });

  it('gives two windows with the same label different ids', async () => {
    await act(async () =>
      root.render(
        <>
          <Editor label="Pair" files={files} />
          <Editor label="Pair" files={files} />
        </>,
      ),
    );
    const ids = [...container.querySelectorAll('[id]')].map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('never makes a tablist of the split layout', async () => {
    expect(renderToString(<Editor label="Pair" files={files} layout="split" />)).not.toContain('role="tablist"');
    await act(async () => root.render(<Editor label="Pair" files={files} layout="split" />));
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(container.textContent).toContain('ShowController.ts');
    expect(container.textContent).toContain('Show.tsx');
  });
});

// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAIN } from '../../chain.ts';
import { ChainSection } from './ChainSection.tsx';

// The links need the running app; the section's markup is what is under test.
vi.mock('@marmeon/react', () => ({ Link: ({ href, children }: { href: string; children: unknown }) => <a href={href}>{children as never}</a> }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const html = (text: string) => `<pre class="code" tabindex="0" data-lang="ts">${text}</pre>`;
const snippets = {
  routes: { file: 'modules/notes/routes.ts', html: html('routes code') },
  ...Object.fromEntries(CHAIN.map((step) => [step.snippet, { html: html(`${step.id} code`) }])),
} as never;
const chain = CHAIN.map((step) => ({ id: step.id, title: step.title, snippet: step.snippet, file: `${step.id}.ts`, mistake: html(`${step.id} typo`), error: step.error })) as never;

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

describe('ChainSection', () => {
  it('lists the seven steps with their error on the server, and has no tablist', () => {
    const markup = renderToString(<ChainSection snippets={snippets} chain={chain} />);
    expect(markup.match(/<li class="chain-step"/g)).toHaveLength(7);
    expect(markup).not.toContain('role="tab"');
    for (const step of CHAIN) expect(markup).toContain(step.id + ' typo');
  });

  it('shows the code and the compile error of the clicked step and hides the others', async () => {
    await act(async () => root.render(<ChainSection snippets={snippets} chain={chain} />));
    const tabs = [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
    const panels = [...container.querySelectorAll<HTMLElement>('[role="tabpanel"]')];
    expect(tabs).toHaveLength(7);
    expect(panels.map((panel) => panel.hidden)).toEqual([false, true, true, true, true, true, true]);
    await act(async () => tabs[3]!.click());
    expect(panels.map((panel) => panel.hidden)).toEqual([true, true, true, false, true, true, true]);
    expect(panels[3]!.textContent).toContain('controller code');
    expect(panels[3]!.textContent).toContain('controller typo');
    expect(panels[3]!.textContent).toContain(`error ${CHAIN[3]!.error.code}: ${CHAIN[3]!.error.message}`);
    expect(tabs[3]!.getAttribute('aria-selected')).toBe('true');
  });
});

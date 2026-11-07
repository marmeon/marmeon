// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { type TabItem, Tabs } from './Tabs.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const items: TabItem[] = [
  { id: 'one', label: 'One', content: <p>first body</p> },
  { id: 'two', label: 'Two', content: <p>second body</p> },
  { id: 'three', label: 'Three', content: <p>third body</p> },
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

async function mount(props: Partial<Parameters<typeof Tabs>[0]> = {}) {
  await act(async () => root.render(<Tabs label="Parts" items={items} idPrefix="parts" {...props} />));
}

const tabs = () => [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
const panels = () => [...container.querySelectorAll<HTMLElement>('[role="tabpanel"]')];
const press = (key: string) => act(async () => void tabs().find((tab) => tab.tabIndex === 0)!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));

describe('Tabs without JavaScript', () => {
  it('stacks every item under its heading, with no tablist and no buttons', () => {
    const html = renderToString(<Tabs label="Parts" items={items} idPrefix="parts" />);
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain('<button');
    for (const text of ['One', 'Two', 'Three', 'first body', 'second body', 'third body']) expect(html).toContain(text);
    expect(html.match(/<h3 class="tabs-heading">/g)).toHaveLength(3);
    expect(html).toContain('<section');
  });

  it('stacks as list items of the given class', () => {
    const html = renderToString(<Tabs label="Parts" items={items} idPrefix="parts" stackAs="ol" itemClassName="chain-step" headingLevel={4} />);
    expect(html).toMatch(/^<ol class="tabs tabs--stack"/);
    expect(html.match(/<li class="chain-step">/g)).toHaveLength(3);
    expect(html).toContain('<h4 class="tabs-heading">');
  });
});

describe('Tabs after hydration', () => {
  it('is a tablist with the first tab selected and the other panels hidden', async () => {
    await mount();
    expect(container.querySelector('[role="tablist"]')?.getAttribute('aria-label')).toBe('Parts');
    expect(tabs().map((tab) => [tab.getAttribute('aria-selected'), tab.tabIndex])).toEqual([
      ['true', 0],
      ['false', -1],
      ['false', -1],
    ]);
    expect(panels().map((panel) => panel.hidden)).toEqual([false, true, true]);
    expect(tabs()[1]!.getAttribute('aria-controls')).toBe(panels()[1]!.id);
    expect(panels()[1]!.getAttribute('aria-labelledby')).toBe(tabs()[1]!.id);
  });

  it('switches on click', async () => {
    await mount();
    await act(async () => tabs()[2]!.click());
    expect(tabs()[2]!.getAttribute('aria-selected')).toBe('true');
    expect(panels().map((panel) => panel.hidden)).toEqual([true, true, false]);
  });

  it('moves with the arrow keys, Home and End, and the focus follows', async () => {
    await mount();
    await press('ArrowRight');
    expect(document.activeElement).toBe(tabs()[1]);
    await press('End');
    expect(document.activeElement).toBe(tabs()[2]);
    await press('ArrowRight');
    expect(document.activeElement).toBe(tabs()[0]);
    await press('ArrowLeft');
    expect(document.activeElement).toBe(tabs()[2]);
    await press('Home');
    expect(document.activeElement).toBe(tabs()[0]);
    expect(panels().map((panel) => panel.hidden)).toEqual([false, true, true]);
  });

  it('uses ArrowDown and ArrowUp when vertical, and ignores the horizontal keys', async () => {
    await mount({ orientation: 'vertical' });
    expect(container.querySelector('[role="tablist"]')?.getAttribute('aria-orientation')).toBe('vertical');
    await press('ArrowRight');
    expect(tabs()[0]!.getAttribute('aria-selected')).toBe('true');
    await press('ArrowDown');
    expect(document.activeElement).toBe(tabs()[1]);
    await press('ArrowUp');
    expect(document.activeElement).toBe(tabs()[0]);
  });

  it('hydrates the server markup without a mismatch and then shows the tablist', async () => {
    await act(async () => root.unmount());
    container = document.createElement('div');
    document.body.replaceChildren(container);
    container.innerHTML = renderToString(<Tabs label="Parts" items={items} idPrefix="parts" />);
    const onRecoverableError = vi.fn();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    onTestFinished(() => error.mockRestore());
    await act(async () => {
      root = hydrateRoot(container, <Tabs label="Parts" items={items} idPrefix="parts" />, { onRecoverableError });
    });
    expect(onRecoverableError).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(container.querySelector('[role="tablist"]')).not.toBeNull();
  });

  it('keeps hidden panels hidden when a class gives them a display', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../../../styles/landing/tabs.css'), 'utf8');
    expect(css).toMatch(/\.tabs \.tabs-panel\[hidden\]\s*\{\s*display:\s*none;/);
  });

  it('sets no style attribute anywhere', async () => {
    await mount();
    expect(container.querySelector('[style]')).toBeNull();
  });
});

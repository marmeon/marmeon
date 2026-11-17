// @vitest-environment happy-dom
import { useRef } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDismissMenus } from './useDismissMenus.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Header({ url }: { url: string }) {
  const header = useRef<HTMLElement>(null);
  useDismissMenus(header, url);
  return (
    <>
      <header ref={header}>
        <details id="one">
          <summary id="one-summary">One</summary>
          <a id="inside" href="/x">
            inside
          </a>
        </details>
        <details id="nested-parent" className="site-menu">
          <summary id="parent-summary">Parent</summary>
          <details id="nested">
            <summary id="nested-summary">Group</summary>
            <a id="nested-link" href="/y">
              deep
            </a>
          </details>
        </details>
        <details id="two">
          <summary>Two</summary>
        </details>
      </header>
      <p id="outside">outside</p>
    </>
  );
}

/** A `matchMedia` the test drives: `narrow.matches` is the answer, `narrow.change()` tells the listeners. */
const narrow = {
  matches: true,
  listeners: new Set<() => void>(),
  change(matches: boolean) {
    narrow.matches = matches;
    for (const listener of narrow.listeners) listener();
  },
};

let root: Root;
const el = (id: string) => document.getElementById(id) as HTMLElement;
const menu = (id: string) => el(id) as HTMLDetailsElement;

beforeEach(async () => {
  narrow.matches = true;
  narrow.listeners.clear();
  vi.stubGlobal('matchMedia', () => ({
    get matches() {
      return narrow.matches;
    },
    addEventListener: (_type: string, listener: () => void) => narrow.listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => narrow.listeners.delete(listener),
  }));
  document.body.replaceChildren();
  root = createRoot(document.body.appendChild(document.createElement('div')));
  await act(async () => root.render(<Header url="/" />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

const press = (key: string) => act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));
const toggled = (id: string) => act(() => void el(id).dispatchEvent(new Event('toggle')));
const pointer = (target: Element) => act(() => void target.dispatchEvent(new Event('pointerdown', { bubbles: true })));

describe('closing the header menus', () => {
  it('closes the open menu on Escape and puts the focus on its summary', () => {
    menu('one').open = true;
    el('inside').focus();
    press('Escape');
    expect(menu('one').open).toBe(false);
    expect(document.activeElement).toBe(el('one-summary'));
  });

  it('closes the one that holds the focus, not another open one', () => {
    menu('one').open = true;
    menu('two').open = true;
    el('inside').focus();
    press('Escape');
    expect(menu('one').open).toBe(false);
    expect(menu('two').open).toBe(true);
  });

  it('closes a nested group first and focuses its summary, and the menu on a second Escape', () => {
    menu('nested-parent').open = true;
    menu('nested').open = true;
    el('nested-link').focus();
    press('Escape');
    expect(menu('nested').open).toBe(false);
    expect(menu('nested-parent').open).toBe(true);
    expect(document.activeElement).toBe(el('nested-summary'));
    press('Escape');
    expect(menu('nested-parent').open).toBe(false);
    expect(document.activeElement).toBe(el('parent-summary'));
  });

  it('closes the open menu on Escape when the focus is on the page body', () => {
    menu('one').open = true;
    (document.activeElement as HTMLElement | null)?.blur();
    press('Escape');
    expect(menu('one').open).toBe(false);
  });

  it('leaves the menus open when something else already handled the Escape', () => {
    menu('one').open = true;
    // On the window, in the capture phase: before the hook's listener on the document.
    window.addEventListener('keydown', (event) => event.preventDefault(), { capture: true, once: true });
    press('Escape');
    expect(menu('one').open).toBe(true);
  });

  it('leaves other keys alone', () => {
    menu('one').open = true;
    press('a');
    expect(menu('one').open).toBe(true);
  });

  it('closes every menu on a press outside the header, and keeps them on a press inside', () => {
    menu('one').open = true;
    menu('two').open = true;
    pointer(el('inside'));
    expect([menu('one').open, menu('two').open]).toEqual([true, true]);
    pointer(el('outside'));
    expect([menu('one').open, menu('two').open]).toEqual([false, false]);
  });

  it('closes the menus when the URL changes, and not on the first render', async () => {
    menu('one').open = true;
    await act(async () => root.render(<Header url="/" />));
    expect(menu('one').open).toBe(true);
    await act(async () => root.render(<Header url="/docs" />));
    expect(menu('one').open).toBe(false);
  });

  it('closes every open menu on Escape when none holds the focus, and focuses the outermost summary', () => {
    menu('nested-parent').open = true;
    menu('nested').open = true;
    (document.activeElement as HTMLElement | null)?.blur();
    press('Escape');
    expect([menu('nested-parent').open, menu('nested').open]).toEqual([false, false]);
    expect(document.activeElement).toBe(el('parent-summary'));
  });

  it('closes both on Escape with the focus on the outer summary while a group is open', () => {
    menu('nested-parent').open = true;
    menu('nested').open = true;
    el('parent-summary').focus();
    press('Escape');
    expect(menu('nested-parent').open).toBe(false);
    toggled('nested-parent');
    expect(menu('nested').open).toBe(false);
  });

  it('closes the groups inside a menu that closes', () => {
    menu('nested-parent').open = true;
    menu('nested').open = true;
    menu('nested-parent').open = false;
    toggled('nested-parent');
    expect(menu('nested').open).toBe(false);
  });
});

describe('the sheet on a narrow screen', () => {
  it('makes the rest of the page inert while the menu is open and lifts it when the menu closes', () => {
    expect(el('outside').hasAttribute('inert')).toBe(false);
    menu('nested-parent').open = true;
    toggled('nested-parent');
    expect(el('outside').hasAttribute('inert')).toBe(true);
    expect(document.querySelector('header')?.hasAttribute('inert')).toBe(false);
    menu('nested-parent').open = false;
    toggled('nested-parent');
    expect(el('outside').hasAttribute('inert')).toBe(false);
  });

  it('keeps an element inert that was inert before the menu opened', () => {
    el('outside').setAttribute('inert', '');
    menu('nested-parent').open = true;
    toggled('nested-parent');
    menu('nested-parent').open = false;
    toggled('nested-parent');
    expect(el('outside').hasAttribute('inert')).toBe(true);
  });

  it('leaves the page alone where the menu is not a sheet', () => {
    narrow.matches = false;
    menu('nested-parent').open = true;
    toggled('nested-parent');
    expect(el('outside').hasAttribute('inert')).toBe(false);
  });

  it('closes the menu and lifts the inert when the window grows past the sheet', () => {
    menu('nested-parent').open = true;
    toggled('nested-parent');
    act(() => narrow.change(false));
    expect(menu('nested-parent').open).toBe(false);
    expect(el('outside').hasAttribute('inert')).toBe(false);
  });

  it('lifts the inert on unmount', async () => {
    menu('nested-parent').open = true;
    toggled('nested-parent');
    const outside = el('outside');
    await act(async () => root.unmount());
    expect(outside.hasAttribute('inert')).toBe(false);
    expect(narrow.listeners.size).toBe(0);
    root = createRoot(document.body.appendChild(document.createElement('div')));
  });
});

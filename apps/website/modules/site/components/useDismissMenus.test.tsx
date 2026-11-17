// @vitest-environment happy-dom
import { useRef } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
        <details id="two">
          <summary>Two</summary>
        </details>
      </header>
      <p id="outside">outside</p>
    </>
  );
}

let root: Root;
const el = (id: string) => document.getElementById(id) as HTMLElement;
const menu = (id: string) => el(id) as HTMLDetailsElement;

beforeEach(async () => {
  document.body.replaceChildren();
  root = createRoot(document.body.appendChild(document.createElement('div')));
  await act(async () => root.render(<Header url="/" />));
});

afterEach(async () => {
  await act(async () => root.unmount());
});

const press = (key: string) => act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));
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
});

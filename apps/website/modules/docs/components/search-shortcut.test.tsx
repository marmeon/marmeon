// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SEARCH_KEYSHORTCUTS, useSearchShortcut, useShortcutHint } from './search-shortcut.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe() {
  useSearchShortcut();
  return null;
}

let root: Root;
let clicks: string[];

beforeEach(async () => {
  document.body.replaceChildren();
  clicks = [];
  root = createRoot(document.body.appendChild(document.createElement('div')));
  await act(async () => root.render(<Probe />));
});

afterEach(async () => {
  await act(async () => root.unmount());
});

/** A link as the trigger; happy-dom has no layout, so `offsetParent` says whether it counts as visible. */
function trigger(id: string, visible = true) {
  const link = document.createElement('a');
  link.setAttribute('data-search-trigger', '');
  link.id = id;
  link.href = '/docs/search';
  link.addEventListener('click', (event) => {
    event.preventDefault();
    clicks.push(id);
  });
  Object.defineProperty(link, 'offsetParent', { get: () => (visible ? document.body : null) });
  document.body.append(link);
  return link;
}

/** An input; the search's own field when `search` (it carries `data-search-field`). */
function field(search = true) {
  const input = document.createElement('input');
  if (search) input.setAttribute('data-search-field', '');
  document.body.append(input);
  return input;
}

/** An open dialog; `open` is set as an attribute because happy-dom's `showModal` is not needed for `dialog[open]`. */
function dialog(...children: HTMLElement[]) {
  const element = document.createElement('dialog');
  element.setAttribute('open', '');
  element.append(...children);
  document.body.append(element);
  return element;
}

function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  act(() => void target.dispatchEvent(event));
  return event;
}

describe('the search shortcut', () => {
  it('names its keys for aria-keyshortcuts', () => {
    expect(SEARCH_KEYSHORTCUTS).toBe('Control+K Meta+K');
  });

  it('does not open the search on "/": no click, not prevented', () => {
    trigger('a');
    const event = press('/');
    expect(clicks).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });

  it('clicks the trigger on Ctrl+K even inside an input', () => {
    trigger('a');
    const input = field(false); // any other field of the page: the chord still opens the search
    const event = press('k', { ctrlKey: true }, input);
    expect(clicks).toEqual(['a']);
    expect(event.defaultPrevented).toBe(true);
  });

  it('clicks the trigger on Meta+K', () => {
    trigger('a');
    press('K', { metaKey: true });
    expect(clicks).toEqual(['a']);
  });

  it('does nothing on Alt+Ctrl+K', () => {
    trigger('a');
    const event = press('k', { ctrlKey: true, altKey: true });
    expect(clicks).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });

  it('opens once for a held key: the repeats are swallowed without another click', () => {
    trigger('a');
    press('k', { ctrlKey: true });
    const repeat = press('k', { ctrlKey: true, repeat: true });
    expect(clicks).toEqual(['a']);
    expect(repeat.defaultPrevented).toBe(true);
  });

  it('does not swallow a held chord that nothing would handle: no trigger, or another dialog open', () => {
    expect(press('k', { ctrlKey: true, repeat: true }).defaultPrevented).toBe(false);
    trigger('a');
    dialog();
    expect(press('k', { ctrlKey: true, repeat: true }).defaultPrevented).toBe(false);
    expect(clicks).toEqual([]);
  });

  it('does nothing while an input method composes', () => {
    trigger('a');
    press('k', { ctrlKey: true, isComposing: true });
    expect(clicks).toEqual([]);
  });

  it('focuses and selects the search field of an open dialog on Ctrl+K and clicks nothing', () => {
    trigger('a');
    const input = field();
    input.value = 'routing';
    dialog(input);
    const event = press('k', { ctrlKey: true });
    expect(clicks).toEqual([]);
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('routing'.length);
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves Ctrl+K alone while another dialog is open: no click, no preventDefault', () => {
    trigger('a');
    dialog();
    const event = press('k', { ctrlKey: true });
    expect(clicks).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });

  it('focuses the search field on the search page, which has no trigger', () => {
    const input = field();
    const event = press('k', { metaKey: true });
    expect(document.activeElement).toBe(input);
    expect(event.defaultPrevented).toBe(true);
  });

  it('skips a hidden trigger for the visible one', () => {
    trigger('hidden', false);
    trigger('shown');
    press('k', { ctrlKey: true });
    expect(clicks).toEqual(['shown']);
  });

  it('does nothing without a visible trigger and does not prevent the default', () => {
    trigger('hidden', false);
    const event = press('k', { ctrlKey: true });
    expect(clicks).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });

  it('stops listening when the component unmounts', async () => {
    trigger('a');
    await act(async () => root.render(null));
    press('k', { ctrlKey: true });
    expect(clicks).toEqual([]);
  });
});

function Hint() {
  return <kbd>{useShortcutHint()}</kbd>;
}

describe('the shortcut hint', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('renders nothing on the server', () => {
    expect(renderToString(<Hint />)).toBe('<kbd></kbd>');
  });

  it('names ⌘K on an Apple platform and Ctrl K elsewhere, once hydrated', async () => {
    const hint = async (platform: string) => {
      vi.stubGlobal('navigator', { platform });
      const host = document.createElement('div');
      const hintRoot = createRoot(host);
      await act(async () => hintRoot.render(<Hint />));
      const text = host.textContent;
      await act(async () => hintRoot.unmount());
      return text;
    };
    expect(await hint('MacIntel')).toBe('⌘K');
    expect(await hint('iPhone')).toBe('⌘K');
    expect(await hint('Win32')).toBe('Ctrl K');
  });
});

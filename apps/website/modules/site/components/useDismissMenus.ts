import { useEffect, useRef, type RefObject } from 'react';

/** Where the header's menu is a sheet: the one query the style sheet also uses. */
const NARROW = '(max-width: 899px)';

/**
 * Closes the `<details>` menus of a header the way a menu should close, once the page runs. Escape closes the innermost open one
 * that holds the focus (a group inside the menu first) and hands the focus back to its summary; with the focus elsewhere it closes
 * them all. A press outside the header closes them all, and so does a visit (`url` changes). A menu that closes takes the groups
 * inside it along. While the narrow screen's sheet (`details.site-menu`) is open, the rest of the page is `inert`, so neither
 * the focus nor a screen reader's cursor reaches what the sheet covers; widening the window closes the sheet. Without JavaScript
 * the menus stay as the browser leaves them.
 */
export function useDismissMenus(header: RefObject<HTMLElement | null>, url: string): void {
  const openMenus = () => Array.from(header.current?.querySelectorAll<HTMLDetailsElement>('details[open]') ?? []);

  // On a visit, not on mount: a menu opened before hydration stays open.
  const shown = useRef(url);
  useEffect(() => {
    if (shown.current === url) return;
    shown.current = url;
    for (const menu of openMenus()) menu.open = false;
  }, [url]);

  useEffect(() => {
    const away = (event: PointerEvent) => {
      if (event.target instanceof Node && header.current?.contains(event.target)) return;
      for (const menu of openMenus()) menu.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const open = openMenus();
      // The holders of the focus are a chain of nested menus, and a nested one comes after its parent in document order.
      const holding = open.filter((candidate) => candidate.contains(document.activeElement));
      const menu = holding.at(-1);
      if (menu) {
        menu.open = false;
        menu.querySelector<HTMLElement>(':scope > summary')?.focus();
        return;
      }
      // The focus is elsewhere: all of them go, and the outermost one's summary takes the focus.
      for (const candidate of open) candidate.open = false;
      open[0]?.querySelector<HTMLElement>(':scope > summary')?.focus();
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', escape);
    };
  }, []);

  useEffect(() => {
    const root = header.current;
    const layout = root?.parentElement;
    if (!root || !layout) return;
    // `toggle` does not bubble; in the capture phase the header sees every nested one.
    const closed = (event: Event) => {
      if (!(event.target instanceof HTMLDetailsElement) || event.target.open) return;
      for (const inner of event.target.querySelectorAll<HTMLDetailsElement>('details[open]')) inner.open = false;
    };
    root.addEventListener('toggle', closed, true);

    const sheet = root.querySelector<HTMLDetailsElement>('details.site-menu');
    const narrow = window.matchMedia(NARROW);
    const marked = new Set<Element>(); // what this hook made inert, so only that is lifted again
    const sync = () => {
      if (sheet?.open && !narrow.matches) sheet.open = false;
      const covered = Boolean(sheet?.open) && narrow.matches;
      if (covered) {
        for (const child of Array.from(layout.children)) {
          if (child === root || (child.hasAttribute('inert') && !marked.has(child))) continue; // inert for another reason: not ours to lift
          child.setAttribute('inert', '');
          marked.add(child);
        }
        return;
      }
      for (const child of marked) child.removeAttribute('inert');
      marked.clear();
    };
    sheet?.addEventListener('toggle', sync);
    narrow.addEventListener('change', sync);
    sync();
    return () => {
      root.removeEventListener('toggle', closed, true);
      sheet?.removeEventListener('toggle', sync);
      narrow.removeEventListener('change', sync);
      for (const child of marked) child.removeAttribute('inert');
    };
  }, []);
}

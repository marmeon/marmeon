import { useEffect, useRef, type RefObject } from 'react';

/**
 * Closes the `<details>` menus of a header the way a menu should close, once the page runs: Escape closes the open one and hands the
 * focus back to its summary, a press outside the header closes them all, and so does a visit (`url` changes). Without JavaScript
 * they stay as the browser leaves them.
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
      const menu = open.find((candidate) => candidate.contains(document.activeElement)) ?? open[0];
      if (!menu) return;
      menu.open = false;
      menu.querySelector('summary')?.focus();
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', escape);
    };
  }, []);
}

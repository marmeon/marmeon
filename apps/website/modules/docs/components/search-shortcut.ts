import { useEffect, useSyncExternalStore } from 'react';

/** For `aria-keyshortcuts` on the triggers. */
export const SEARCH_KEYSHORTCUTS = 'Control+K Meta+K';

/** The search field carries this attribute; its id is the view's own (`useId`), so no id is looked up. */
const SEARCH_FIELD = 'input[data-search-field]';

/** The trigger that is showing: one is hidden on a phone, the other on a desktop. */
function visibleTrigger(): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-search-trigger]')).find((element) => element.offsetParent !== null);
}

function focusField(field: HTMLInputElement): void {
  field.focus();
  field.select();
}

/**
 * ⌘K or Ctrl+K opens the search by clicking the visible `[data-search-trigger]` link, also from inside a field. In the open
 * search layer, or on the search page, the chord focuses and selects the field instead; another open dialog keeps ⌘K and
 * Ctrl+K. A held key opens the layer once. A key that is not handled is not prevented.
 */
export function useSearchShortcut(): void {
  useEffect(() => {
    const listen = (event: KeyboardEvent) => {
      const chord = (event.metaKey || event.ctrlKey) && !event.altKey && (event.key ?? '').toLowerCase() === 'k';
      if (!chord || event.isComposing) return;

      const open = document.querySelector('dialog[open]');
      const field = (open ?? document).querySelector<HTMLInputElement>(SEARCH_FIELD);
      // No second layer behind an open one: without a field to focus, an open dialog keeps the key.
      const trigger = field || open ? undefined : visibleTrigger();
      if (!field && !trigger) return; // nothing would handle it: the browser keeps the key
      event.preventDefault();
      // A held key repeats: one press opens the layer, the rest would only fire more requests at the throttled search route.
      if (event.repeat) return;
      if (field) {
        focusField(field);
        return;
      }
      // Clicking opens the layer and lets the layer hand the focus back to the link.
      trigger!.focus();
      trigger!.click();
    };
    document.addEventListener('keydown', listen);
    return () => document.removeEventListener('keydown', listen);
  }, []);
}

const noop = () => () => {};

/** The chord for this machine as the trigger shows it: `⌘K` or `Ctrl K`; `null` on the server and while hydrating, so the markup never mismatches. */
export function useShortcutHint(): string | null {
  return useSyncExternalStore(noop, hint, () => null);
}

function hint(): string {
  const { userAgentData, platform } = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /mac|iphone|ipad/i.test(userAgentData?.platform ?? platform ?? '') ? '⌘K' : 'Ctrl K';
}

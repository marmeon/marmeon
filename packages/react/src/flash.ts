import type { CheckFlashKey, FlashKey, FlashMessage } from '@marmeon/http/page';
import { useEffect, useRef } from 'react';
import { useRouterContext } from './app.tsx';

/** What a message of key `K` brings — its data as the browser got it (`Serialize`), and the message (its id). */
export type FlashHandler<K extends FlashKey> = (data: FlashMessage<K>['data'], message: FlashMessage<K>) => void;

/**
 * Runs `handler` for every flash message of `key` (E60) — exactly once per message: with the answer that delivered it (a page,
 * a partial reload, a layer, an action), never again for a reload, Back/Forward or a page shown from memory, and twice for
 * the same message flashed twice. Messages that arrived before this component mounted and that nobody heard yet come at once
 * (the first page's). Typed by the app's `FlashData`.
 *
 * ```tsx
 * useFlash('toast', (toast) => toaster.show(toast));     // in the layout
 * ```
 *
 * In the browser only (an effect): on the server, the page object's `flash` is what a `<noscript>` may show.
 */
export function useFlash<const K extends string>(key: CheckFlashKey<K>, handler: FlashHandler<K & FlashKey>): void {
  const navigator = useRouterContext().navigator();
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(
    () => navigator?.onFlash(key as FlashKey, (message) => latest.current(message.data as FlashMessage<K & FlashKey>['data'], message as FlashMessage<K & FlashKey>)),
    [navigator, key],
  );
}

import type { CheckFlashKey, FlashKey, FlashMessage } from '@marmeon/http/page';
import { useEffect, useRef } from 'react';
import { useRouterContext } from './app.tsx';

/** What a message of key `K` brings — its data as the browser got it (`Serialize`), and the message (its id). */
export type FlashHandler<K extends FlashKey> = (data: FlashMessage<K>['data'], message: FlashMessage<K>) => void;

/**
 * Runs `handler` for every flash message of `key`, typed by the app's `FlashData` — exactly once per message, never again for
 * a reload, Back/Forward or a page shown from memory; messages nobody heard before this component mounted fire at once. In the
 * browser only (an effect): on the server, the page object's `flash` is what a `<noscript>` may show.
 * See docs/pages.md#flash-messages.
 */
export function useFlash<const K extends string>(key: CheckFlashKey<K>, handler: FlashHandler<K & FlashKey>): void {
  const navigator = useRouterContext().navigator();
  // The handler is typed per key; the router hands over any key's message, and only `key`'s ever arrives. Stored untyped:
  // with several `FlashData` keys a call through `FlashHandler<K & FlashKey>` would need the intersection of their data.
  const latest = useRef<(data: unknown, message: FlashMessage) => void>(handler as (data: unknown, message: FlashMessage) => void);
  latest.current = handler as (data: unknown, message: FlashMessage) => void;
  useEffect(() => navigator?.onFlash(key as FlashKey, (message) => latest.current(message.data, message)), [navigator, key]);
}

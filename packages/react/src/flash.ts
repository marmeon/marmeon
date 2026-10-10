import type { CheckFlashKey, FlashKey, FlashMessage } from '@marmeon/http/page';
import { useEffect, useRef } from 'react';
import { useRouterContext } from './app.tsx';

/** What a message of key `K` brings — its data as the browser got it (`Serialize`), and the message (its id). */
export type FlashHandler<K extends FlashKey> = (data: FlashMessage<K>['data'], message: FlashMessage<K>) => void;

/**
 * Runs `handler` for every flash message of `key`, typed by the app's `FlashData` — exactly once per message, never again for
 * a reload, Back/Forward or a page shown from memory; messages that came before this component mounted fire at once. In the
 * browser only (an effect): on the server, the page object's `flash` is what a `<noscript>` may show.
 * See docs/pages.md#flash-messages.
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

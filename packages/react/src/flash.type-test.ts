// Type guarantees of useFlash with several FlashData keys — checked by `tsc` (pnpm build / typecheck), never run.
// The augmentation is package-wide for tsc, so `toast` stays what the runtime tests send.
import type { FlashMessage } from '@marmeon/http/page';
import { useFlash } from './flash.ts';

declare module '@marmeon/http/page' {
  interface FlashData {
    toast: { message: string };
    draft: { saved: boolean };
  }
}

export function severalKeys() {
  useFlash('toast', (data, message) => {
    const text: string = data.message;
    const id: string = message.id;
    // @ts-expect-error — `saved` belongs to the `draft` key
    data.saved;
    return [text, id];
  });
  useFlash('draft', (data) => {
    const saved: boolean = data.saved;
    // @ts-expect-error — `message` belongs to the `toast` key
    data.message;
    return saved;
  });
  // @ts-expect-error — not a key of the app
  useFlash('missing', () => {});
  const both: FlashMessage['key'] = 'draft';
  return both;
}

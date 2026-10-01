import type { PageProps } from '@bespokecore/http';
import { Head } from '@bespokecore/react';
import type { ShowClientOnlyLabController } from '../controllers/ShowLabPageController.ts';

/**
 * Reads `window` while rendering — a bug on the server (`ReferenceError: window is not defined`). The server logs it
 * and sends the page without markup; the browser renders it (client fallback). `BrowserOnly.ssr = false` is the fix.
 */
export default function ClientOnly({ now }: PageProps<ShowClientOnlyLabController>) {
  const width = window.innerWidth;
  return (
    <main>
      <Head title="Client only" />
      <h1>Client only</h1>
      <p data-client-only>
        Rendered in the browser, {width}px wide (requested at {now.slice(11, 19)} UTC).
      </p>
    </main>
  );
}

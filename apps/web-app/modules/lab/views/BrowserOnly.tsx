import { Head } from '@marmeon/react';

/** Needs the browser to render, so it opts out of server rendering: the server sends the page object, the browser renders. */
export default function BrowserOnly() {
  return (
    <main>
      <Head title="Browser only" />
      <h1>Browser only</h1>
      <p data-browser-only>Rendered in the browser ({navigator.language}) — this page sets `ssr = false`.</p>
    </main>
  );
}
BrowserOnly.ssr = false as const;

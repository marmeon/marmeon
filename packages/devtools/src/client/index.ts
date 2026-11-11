/**
 * `@marmeon/devtools/client` — the in-page bar. **Development only:** the devtools' provider puts
 * `<script type="module" src="/@id/@marmeon/devtools/client">` into the head of every document the Vite dev server renders
 * (`DevDocument`, bound with `NODE_ENV=development` only); nothing else imports it, so no build ever contains it.
 *
 * Loaded before the app's entry, it sets the dev hook (`__MARMEON_DEVTOOLS_HOOK__`): when the app makes its navigator, the bar
 * attaches its data feature to it and shows itself — plain DOM in a shadow root, bottom right (`Alt+Shift+D`). It also reports the page's
 * errors to the dev server (docs/devtools.md#browser-errors). It exports nothing.
 */
import type { DevtoolsGlobal } from '@marmeon/http/client/adapter';
import { BROWSER_LOG_EVENT } from '@marmeon/http/protocol';
import { DevtoolsBar } from './bar.ts';
import { installBrowserLog } from './browser-log.ts';
import { installDevtoolsHook } from './hook.ts';

if (typeof document !== 'undefined') {
  let bar: DevtoolsBar | undefined;
  // The document's own request — the server's record of it, for the Page and SSR tabs.
  const requestId = document.querySelector('meta[name="marmeon-devtools"]')?.getAttribute('content') || undefined;
  // Errors of the page go to the dev server over Vite's HMR channel; a page without it (no dev server behind) reports nothing.
  const hot = (import.meta as { hot?: { send(event: string, data: unknown): void } }).hot;
  installBrowserLog(globalThis, hot && ((report) => hot.send(BROWSER_LOG_EVENT, report)), { requestId, page: () => location.pathname + location.search });
  installDevtoolsHook(globalThis as DevtoolsGlobal, ({ navigator, api }) => {
    api.record.document(navigator.page.url, requestId);
    // Drawn once the body is there, outside the app's root (never in what React hydrates) — after the render that made the navigator.
    const mount = () => {
      bar?.destroy();
      bar = new DevtoolsBar({ navigator, api });
    };
    if (document.body) queueMicrotask(mount);
    else document.addEventListener('DOMContentLoaded', mount, { once: true });
  });
}

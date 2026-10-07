/**
 * `@marmeon/devtools/client` — the in-page bar (W7 step 9, E117). **Development only (E115):** the devtools' provider puts
 * `<script type="module" src="/@id/@marmeon/devtools/client">` into the head of every document the Vite dev server renders
 * (`DevDocument`, bound with `NODE_ENV=development` only); nothing else imports it, so no build ever contains it.
 *
 * Loaded before the app's entry, it sets the dev hook (`__MARMEON_DEVTOOLS_HOOK__`): when the app makes its navigator, the bar
 * attaches its data feature to it and shows itself — plain DOM in a shadow root, bottom right (`Alt+Shift+D`).
 */
import type { DevtoolsGlobal } from '@marmeon/http/client';
import { DevtoolsBar } from './bar.ts';
import { installDevtoolsHook } from './hook.ts';

export { DevtoolsBar, SHORTCUT, STATE_KEY, TABS } from './bar.ts';
export type { BarOptions, BarTab } from './bar.ts';
export { installDevtoolsHook } from './hook.ts';
export type { Attached } from './hook.ts';

if (typeof document !== 'undefined') {
  let bar: DevtoolsBar | undefined;
  // The document's own request (E131) — the server's record of it, for the Page and SSR tabs.
  const requestId = document.querySelector('meta[name="marmeon-devtools"]')?.getAttribute('content') || undefined;
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

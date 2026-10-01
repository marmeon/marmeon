/**
 * Type guarantees of server rendering per page (W5 step 7) — checked by `tsc` (`pnpm typecheck`, `bespoke build`), never run.
 */
import type { SsrRender, SsrRenderOptions } from '@bespokecore/http/page';
import type { PageComponent, PageSsr } from '@bespokecore/react';
import { createSsrRenderer } from '@bespokecore/react/server';

export function Canvas() {
  return null;
}
Canvas.ssr = false satisfies PageSsr; // the browser renders it
export function Report() {
  return null;
}
// `as const`: an expando property widens a string literal to `string` (TypeScript), which PageComponent refuses.
Report.ssr = 'complete' as const satisfies PageSsr; // the whole page before the first byte
export const pages: PageComponent[] = [Canvas, Report];

export function Typo() {
  return null;
}
// @ts-expect-error — only true, false or 'complete'
Typo.ssr = 'stream' satisfies PageSsr;
// @ts-expect-error — collected as pages, the property is checked
export const typos: PageComponent[] = [Object.assign(() => null, { ssr: 'yes' })];

// The SSR entry's contract: a stream (or a string), rendered from the page as the browser gets it.
export const render: SsrRender = createSsrRenderer(async () => Canvas);
export const options: SsrRenderOptions = { complete: true, onError: (error) => void error, onWarning: (message) => void message };
// @ts-expect-error — `complete`, not a mode name
export const wrong: SsrRenderOptions = { mode: 'complete' };

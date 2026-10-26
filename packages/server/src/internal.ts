/**
 * What the framework's own packages import from the server: the dev server's pieces, the loopback checks, the request recorder
 * of the development error page. Not API, can change in any release — an app imports from `@marmeon/server`.
 * @internal
 */
import type { Application } from '@marmeon/core';
export { refuseUndecidedRoutes } from './kernel.ts';
export { heldOnLoopback, shadowedLocalhost } from './loopback.ts';
export { DevDocument } from './dev-document.ts';
export type { DevMarkup } from './dev-document.ts';
export type { PageRenderer } from './render.ts';
export { DevRequestRecorder } from './error-page/recorder-token.ts';
/** Loads the recorder of the development error page — only where it is used, never on a production start. */
export const importRequestRecorder = () => import('./error-page/recorder.ts');
/** Starts writing the last 5xx error to `.marmeon/last-error.md` — where the development server starts; loads its code only then. */
export const startLastError = async (app: Application) => (await import('./last-error.ts')).writeLastError(app);
export { marmeonEntries, createViteDevRenderer, explainConfigError, importVite } from './vite.ts';
export type { ViteDevOptions } from './vite.ts';

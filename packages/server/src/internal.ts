/**
 * What the framework's own packages import from the server: the dev server's pieces, the loopback checks, the request recorder
 * of the development error page. Not API, can change in any release — an app imports from `@marmeon/server`.
 * @internal
 */
export { refuseUndecidedRoutes } from './kernel.ts';
export { heldOnLoopback, shadowedLocalhost } from './loopback.ts';
export { DevDocument } from './dev-document.ts';
export type { DevMarkup } from './dev-document.ts';
export { DevRequestRecorder } from './error-page/recorder-token.ts';
/** Loads the recorder of the development error page — only where it is used, never on a production start. */
export const importRequestRecorder = () => import('./error-page/recorder.ts');
export { marmeonEntries, createViteDevRenderer, explainConfigError, importVite } from './vite.ts';
export type { ViteDevOptions } from './vite.ts';

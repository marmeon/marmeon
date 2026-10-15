/**
 * The framework's own entry points. Packages of this repository load their routes with `FRAMEWORK_ROUTES`; an app has no
 * reason to, and the symbol is deliberately absent from the package index.
 * @internal
 */
export { isEveryone } from './access.ts';
export { FRAMEWORK_ROUTES } from './router.ts';
export { localLocation } from './url.ts';

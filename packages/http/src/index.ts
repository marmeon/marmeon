export { Controller } from './controller.ts';
export { view, isViewResult } from './view.ts';
export type { PageProps, ViewProps, ViewResult } from './view.ts';
export { PAGE_HEADER, PAGE_SCRIPT_ID, isPageObject } from './page.ts';
export type { PageObject, SsrRender, SsrResult } from './page.ts';

// Re-exported so application code has a single import for the HTTP surface.
export { defineMiddleware, defineRoutes } from '@bespokecore/router';
export type { EmptyObject, HttpContext, Middleware } from '@bespokecore/router';
export { HttpServiceProvider } from './provider.ts';
export type { MiddlewareClass, Next } from '@bespokecore/router';

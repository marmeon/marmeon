export { BaseController } from './base-controller.ts';
export { view, isViewResult } from './view.ts';
export type { PageProps, ViewProps, ViewResult } from './view.ts';

// Re-exported so application code has a single import for the common surface.
export { defineMiddleware, defineRoutes } from '@bespokecore/router';
export type { EmptyObject, HttpContext, Middleware } from '@bespokecore/router';

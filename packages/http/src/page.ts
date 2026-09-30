/**
 * The page contract shared by the server and UI adapters — importable in the
 * browser as `@bespokecore/http/page`, so it must stay free of server code.
 */
import type { ViewProps } from './view.ts';

export type { PageProps, ViewProps, ViewResult } from './view.ts';
// Types only — erased, so the browser bundle stays free of router code.
export type { FormOf, ValidationErrors } from '@bespokecore/router';

/**
 * Props every page receives, next to its controller's own — the signed-in user,
 * flash messages, validation errors. Declared by whoever shares them:
 *
 * ```ts
 * declare module '@bespokecore/http/page' {
 *   interface SharedProps { auth: { user: { id: string; name: string } | null } }
 * }
 * ```
 *
 * `PageProps<Controller>` includes them, and the server fills them in (`SharedData`).
 */
export interface SharedProps {}

/** The wire format of a page — shared by the server and every UI adapter. */
export interface PageObject {
  component: string;
  props: ViewProps;
  url: string;
  /** Build version of the assets (null in development). A client with another version reloads fully. */
  version?: string | null;
}

/** Client-side navigations send this header and receive the page object as JSON. */
export const PAGE_HEADER = 'x-bespoke';

/** The asset version the client was built with; a mismatch answers 409 (Inertia's `X-Inertia-Version`). */
export const VERSION_HEADER = 'x-bespoke-version';

/** With a 409: where the client should load fully (Inertia's `X-Inertia-Location`). */
export const LOCATION_HEADER = 'x-bespoke-location';

/** Id of the `<script type="application/json">` that carries the initial page. */
export const PAGE_SCRIPT_ID = 'bespoke-page';

export interface SsrResult {
  html: string;
  head?: string;
}

/** Contract of an app's SSR entry (`export const render: SsrRender`). */
export type SsrRender = (page: PageObject) => Promise<SsrResult>;

export function isPageObject(value: unknown): value is PageObject {
  return typeof value === 'object' && value !== null && 'component' in value && 'props' in value && 'url' in value;
}

/** The page every error renders. Apps override it with `modules/errors/views/Error.tsx`. */
export const ERROR_PAGE = 'errors/Error';

export interface ErrorPageProps {
  status: number;
  title: string;
  message: string;
  /** Only in debug mode. */
  exception: { name: string; message: string; stack: string } | null;
}

import type { ViewProps } from './view.ts';

/** The wire format of a page — shared by the server and every UI adapter. */
export interface PageObject {
  component: string;
  props: ViewProps;
  url: string;
}

/** Client-side navigations send this header and receive the page object as JSON. */
export const PAGE_HEADER = 'x-bespoke';

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

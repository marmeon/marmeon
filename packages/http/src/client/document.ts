import { isPageObject, PAGE_SCRIPT_ID, type PageObject } from '../page.ts';

/**
 * The page the server rendered — the JSON in `<script id="marmeon-page" type="application/json">` (in the document
 * head, so it is there before the streamed markup is). Every adapter's hydration entry starts here.
 */
export function readInitialPage(doc: Pick<Document, 'getElementById'> = document): PageObject {
  const page: unknown = JSON.parse(doc.getElementById(PAGE_SCRIPT_ID)?.textContent ?? 'null');
  if (!isPageObject(page)) throw new Error(`Missing or invalid #${PAGE_SCRIPT_ID} script — was the page server-rendered?`);
  return page;
}

/** The element the server rendered into — waits for it while a streamed document is still arriving. */
export async function rootElement(rootId: string, doc: Document = document): Promise<HTMLElement> {
  let root = doc.getElementById(rootId);
  if (!root && doc.readyState === 'loading') {
    await new Promise((resolve) => doc.addEventListener('DOMContentLoaded', resolve, { once: true }));
    root = doc.getElementById(rootId);
  }
  if (!root) throw new Error(`Root element #${rootId} not found.`);
  return root;
}

/**
 * Whether the server rendered markup into `root`: hydrate it then. Without markup — server rendering failed (the
 * server logged why) or the page has `ssr = false` — the adapter renders the page itself.
 */
export function hasServerMarkup(root: Pick<Element, 'childNodes'>): boolean {
  // 3 = Node.TEXT_NODE (not every environment has a global `Node`).
  return [...root.childNodes].some((node) => node.nodeType !== 3 || (node.textContent ?? '').trim() !== '');
}

/**
 * Development builds and tests — `NODE_ENV` is `development` or `test` (E201: checked positively, so `production`, a value a hand-made build bakes in, or none
 * is production — fail-closed like E139). A client build has it replaced by Vite (`process.env.NODE_ENV || mode`, at build
 * time) and folds the check away; server rendering reads it at run time (Vite leaves it alone in the SSR build).
 * Without a bundler that replaces it, `process` does not exist in the browser: production.
 */
export function isDevelopment(): boolean {
  try {
    return process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
  } catch {
    return false;
  }
}

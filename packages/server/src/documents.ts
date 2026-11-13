import { escapeHtml } from '@marmeon/core';
import { CSP_NONCE_PLACEHOLDER, withCode } from '@marmeon/core/internal';
import { FALLBACK_TEMPLATE, HEAD_OUTLET } from './html.ts';

/** The document a page renders in: the app's (`app`) or the namespace of a package with an entry of its own. */
export type DocumentName = string;

/** A view names a namespace the app has no package for — or a package whose entry the build does not know. */
export class UnknownEntryError extends Error {
  override name = 'UnknownEntryError';
  constructor(namespace: string) {
    super(withCode('H16', `The view's namespace "${namespace}" belongs to no installed package, so no document can show it: check the namespace in its name, and that the package is installed and built.`));
  }
}

/** The packages a document can be chosen among. */
export interface DocumentTable {
  /** Namespaces of the packages with an entry: each has a document of its own. */
  readonly entries: ReadonlySet<string>;
  /** Namespaces of every installed package (those with an entry too): a page of one without an entry renders in the app's document. */
  readonly installed: ReadonlySet<string>;
}

/**
 * The document `view` renders in — the one place that decides. A view without `::` is the app's; `<namespace>::…` of a package with an
 * entry is that entry's; of an installed package without one, the app's; of an unknown namespace it is `H16`, never the app's document.
 */
export function documentFor(view: string, { entries, installed }: DocumentTable): DocumentName {
  const at = view.indexOf('::');
  if (at === -1) return 'app';
  const namespace = view.slice(0, at);
  if (entries.has(namespace)) return namespace;
  if (installed.has(namespace)) return 'app';
  throw new UnknownEntryError(namespace);
}

/** The comment that tells `@marmeon/vite` this document brings its own entry, so it adds none (`PACKAGE_ENTRY_MARK` there: change both together). */
export const PACKAGE_ENTRY_MARK = '<!--marmeon:package-entry-->';

const NONCE = ` nonce="${CSP_NONCE_PLACEHOLDER}"`;

/** What a package's document links, from its entry's closure: the entry script, its static imports and its stylesheets. */
export interface PackageDocumentParts {
  /** The entry's script, as a path on the app's origin. */
  readonly script: string;
  /** The chunks the entry imports statically. */
  readonly preloads: readonly string[];
  readonly stylesheets: readonly string[];
}

/**
 * The document of a package's entry, put together by the server: the standard template with the entry's script (`async`, as the app's),
 * stylesheets and preloads where the template's head outlet is. Every tag carries the nonce placeholder. No HTML of the package is in it.
 */
export function packageTemplate({ script, preloads, stylesheets }: PackageDocumentParts): string {
  const tags = [
    PACKAGE_ENTRY_MARK,
    `<script type="module" async crossorigin src="${escapeHtml(script)}"${NONCE}></script>`,
    ...stylesheets.map((href) => `<link rel="stylesheet" crossorigin href="${escapeHtml(href)}"${NONCE}>`),
    ...preloads.map((href) => `<link rel="modulepreload" crossorigin href="${escapeHtml(href)}"${NONCE}>`),
  ].join('\n');
  return FALLBACK_TEMPLATE.replace(HEAD_OUTLET, () => `${tags}\n${HEAD_OUTLET}`);
}

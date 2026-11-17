import type { DocsDefinition } from '../../docs.config.ts';
import { DOCS_URL } from './links.ts';
import { pageIndex } from './menu.ts';
import type { PackageEntry } from './packages.ts';

/** A layer of the hero's diagram, as written here: the docs page it links is a slug. */
interface StackLayerSpec {
  readonly title: string;
  readonly note: string;
  readonly docs: string;
}

/** The layers of a Marmeon app, top to bottom: what the user meets first, what holds the data last. */
export const STACK_LAYERS: readonly StackLayerSpec[] = [
  { title: 'Forms', note: 'Validation errors per field', docs: 'forms' },
  { title: 'Pages', note: 'React, rendered on the server', docs: 'pages' },
  { title: 'Controllers', note: 'One class per endpoint', docs: 'controllers' },
  { title: 'Queries', note: 'Typed rows', docs: 'queries' },
  { title: 'Database', note: 'Migrations', docs: 'migrations' },
];

/** The batteries around the layers: the package, and the short name on its chip. */
export const STACK_BATTERIES: { readonly above: readonly { readonly name: string; readonly label: string }[]; readonly below: readonly { readonly name: string; readonly label: string }[] } = {
  above: [
    { name: '@marmeon/auth', label: 'Auth' },
    { name: '@marmeon/mail', label: 'Mail' },
    { name: '@marmeon/queue', label: 'Queue' },
    { name: '@marmeon/storage', label: 'Storage' },
  ],
  below: [
    { name: '@marmeon/scheduler', label: 'Scheduler' },
    { name: '@marmeon/cache', label: 'Cache' },
    { name: '@marmeon/notifications', label: 'Notifications' },
    { name: '@marmeon/live', label: 'Live' },
  ],
};

/** A layer or a chip as the page renders it. */
export interface StackLink {
  readonly title: string;
  readonly note?: string;
  readonly href: string;
}

/** The hero's diagram, resolved: every `href` leads to a docs page that exists. */
export interface Stack {
  readonly layers: readonly StackLink[];
  readonly above: readonly StackLink[];
  readonly below: readonly StackLink[];
}

/**
 * Resolves the hero's diagram to links the way the menu does: a docs slug `docs.config.ts` does not list, or a package
 * `packages.ts` does not list, throws — so the diagram never links a 404 and the app does not start.
 */
export function buildStack(docs: DocsDefinition, packages: readonly PackageEntry[], spec = { layers: STACK_LAYERS, batteries: STACK_BATTERIES }): Stack {
  const pages = pageIndex(docs);
  const docsHref = (slug: string): string => {
    if (!pages.has(slug)) throw new Error(`The hero's stack points at the docs page '${slug}', which docs.config.ts does not list.`);
    return `${DOCS_URL}/${slug}`;
  };
  const chip = ({ name, label }: { readonly name: string; readonly label: string }): StackLink => {
    const entry = packages.find((candidate) => candidate.name === name);
    if (entry === undefined) throw new Error(`The hero's stack names the package '${name}', which packages.ts does not list.`);
    return { title: label, href: docsHref(entry.docs) };
  };
  return {
    layers: spec.layers.map((layer) => ({ title: layer.title, note: layer.note, href: docsHref(layer.docs) })),
    above: spec.batteries.above.map(chip),
    below: spec.batteries.below.map(chip),
  };
}

/** The resolved stack as an app singleton, built at boot so a bad slug or package stops the start, not the first request. */
export class SiteStack {
  readonly stack: Stack;

  constructor(stack: Stack) {
    this.stack = stack;
  }
}

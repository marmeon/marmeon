import type { DocsDefinition } from '../../docs.config.ts';
import { DISCUSSIONS_URL, DOCS_URL, GET_STARTED_SLUG, GITHUB_URL } from './links.ts';
import type { PackageEntry } from './packages.ts';

export type MenuIcon = 'why' | 'rules' | 'battery' | 'shield' | 'flask' | 'island' | 'code' | 'agent' | 'pkg' | 'plus' | 'wrench' | 'doc' | 'term' | 'chat' | 'tag';

export interface MenuItem {
  readonly title: string;
  readonly text: string;
  readonly href: string;
  readonly icon: MenuIcon;
  /** Leaves the website: opened with `rel="noopener"` instead of through the router. */
  readonly external?: true;
}

export interface MenuColumn {
  readonly title: string;
  readonly items: readonly MenuItem[];
}

export interface MenuPanel {
  readonly id: 'framework' | 'packages' | 'resources';
  readonly label: string;
  readonly columns: readonly MenuColumn[];
  readonly feature: {
    readonly eyebrow: string;
    readonly title: string;
    readonly text: string;
    /** Shell lines shown in a small terminal panel. */
    readonly lines?: readonly string[];
    readonly link: { readonly text: string; readonly href: string };
  };
}

/** The docs pages by slug with their name in the navigation, from `docs.config.ts`. */
export function pageIndex(docs: DocsDefinition): Map<string, string> {
  return new Map(docs.sections.flatMap((section) => section.pages.map((page) => [page.slug, page.label] as const)));
}

/**
 * The landing's mega menu — Framework, Packages and Resources — made from what exists: the docs' pages (named as the navigation
 * names them), the packages with their one-line texts, and the links of `links.ts`. Every target that leads into the docs goes
 * through one check: a slug `docs.config.ts` does not list — for an item, a package's page or a feature link — throws, so a menu
 * never points at a 404 and the app does not start. The off-site links (GitHub) are constants, not checked here.
 */
export function buildMenu(docs: DocsDefinition, packages: readonly PackageEntry[]): MenuPanel[] {
  const pages = pageIndex(docs);
  /** The page's name in the navigation; throws for a slug the docs do not list. */
  const label = (slug: string): string => {
    const found = pages.get(slug);
    if (found === undefined) throw new Error(`The menu points at the docs page '${slug}', which docs.config.ts does not list.`);
    return found;
  };
  const docsHref = (slug: string): string => {
    label(slug);
    return `${DOCS_URL}/${slug}`;
  };
  const page = (slug: string, text: string, icon: MenuIcon, name?: string): MenuItem => ({ title: name ?? label(slug), text, href: docsHref(slug), icon });
  const pkg = (name: string, icon: MenuIcon): MenuItem => {
    const entry = packages.find((candidate) => candidate.name === name);
    if (entry === undefined) throw new Error(`The menu names the package '${name}', which packages.ts does not list.`);
    return { title: entry.name, text: entry.text, href: docsHref(entry.docs), icon };
  };
  const inEveryApp = packages.filter((entry) => entry.group === 'app').length;

  return [
    {
      id: 'framework',
      label: 'Framework',
      columns: [
        {
          title: 'OVERVIEW',
          items: [
            page('why-marmeon', 'One framework for the whole app, server first.', 'why'),
            page('first-app', 'Build a small app from the first command on.', 'rules'),
            page('structure', 'Where a module and its files live.', 'battery'),
            page('modules', 'How the app finds its modules.', 'pkg'),
          ],
        },
        {
          title: 'FEATURES',
          items: [
            page('security', 'The protections an app has without asking.', 'shield'),
            page('testing', 'Through the whole kernel, with fakes.', 'flask', 'Testing'),
            page('deferred-props', 'Parts of a page that load on their own.', 'island'),
            page('devtools', 'See what a request did.', 'code'),
            page('agents', 'Your coding agent reads what you read.', 'agent'),
          ],
        },
      ],
      feature: {
        eyebrow: 'GET STARTED',
        title: 'Three commands to a running app.',
        text: 'The starter kit brings sign-in, devtools, oxlint and Vitest.',
        lines: ['pnpm create marmeon my-app', 'cd my-app', 'pnpm dev'],
        link: { text: label(GET_STARTED_SLUG), href: docsHref(GET_STARTED_SLUG) },
      },
    },
    {
      id: 'packages',
      label: 'Packages',
      columns: [
        {
          title: 'IN EVERY NEW APP',
          items: ['@marmeon/core', '@marmeon/router', '@marmeon/auth', '@marmeon/database', '@marmeon/react'].map((name) => pkg(name, 'pkg')),
        },
        { title: 'ADD WHEN YOU NEED IT', items: ['@marmeon/redis', '@marmeon/table', '@marmeon/otel'].map((name) => pkg(name, 'plus')) },
        { title: 'TOOLING', items: ['@marmeon/vite', '@marmeon/testing', '@marmeon/devtools'].map((name) => pkg(name, 'wrench')) },
      ],
      feature: {
        eyebrow: 'ONE RELEASE',
        title: `${packages.length} packages, one version.`,
        text: `Released together and wired to each other. ${inEveryApp} of them come with every new app.`,
        link: { text: 'All packages', href: docsHref('packages') },
      },
    },
    {
      id: 'resources',
      label: 'Resources',
      columns: [
        {
          title: 'LEARN',
          items: [
            { title: 'Documentation', text: 'Every topic on its own page.', href: DOCS_URL, icon: 'doc' },
            page('installation', 'Requirements, the starter kit and its flags.', 'term'),
            page('upgrading', 'What changed between versions, and what to do about it.', 'tag'),
            page('recipe-resource', 'A worked example, from the route to its policy.', 'rules'),
          ],
        },
        {
          title: 'COMMUNITY',
          items: [
            { title: 'GitHub', text: 'The source and the issues.', href: GITHUB_URL, icon: 'code', external: true },
            { title: 'GitHub Discussions', text: 'Questions, ideas and show and tell.', href: DISCUSSIONS_URL, icon: 'chat', external: true },
            { title: 'Releases and Support', text: 'Which versions get fixes, and for how long.', href: docsHref('releases'), icon: 'tag' },
            { title: 'Security Policy', text: 'How to report a vulnerability.', href: docsHref('security-policy'), icon: 'shield' },
          ],
        },
      ],
      feature: {
        eyebrow: 'UPGRADING',
        title: 'Move to the next version.',
        text: 'The upgrade guide lists every change an app has to act on.',
        link: { text: label('upgrading'), href: docsHref('upgrading') },
      },
    },
  ];
}

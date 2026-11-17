import { describe, expect, it } from 'vitest';
import docs, { type DocsDefinition } from '../../docs.config.ts';
import { buildMenu } from './menu.ts';
import { PACKAGES } from './packages.ts';

const slugs = new Set(docs.sections.flatMap((section) => section.pages.map((page) => page.slug)));
const panels = () => buildMenu(docs, PACKAGES);
const items = () => panels().flatMap((panel) => panel.columns.flatMap((column) => column.items));
const without = (slug: string): DocsDefinition => ({ sections: docs.sections.map((section) => ({ ...section, pages: section.pages.filter((page) => page.slug !== slug) })) });

describe('the mega menu', () => {
  it('offers Framework, Packages and Resources, each with its columns and their exact items', () => {
    expect(panels().map((panel) => [panel.label, panel.columns.map((column) => [column.title, column.items.map((item) => item.title)])])).toEqual([
      ['Framework', [['Overview', ['Why Marmeon', 'Your First App', 'Directory Structure', 'Modules & Discovery']], ['Features', ['Security Overview', 'Testing', 'Deferred Props & Islands', 'Devtools', 'Coding Agents']]]],
      [
        'Packages',
        [
          ['In every new app', ['@marmeon/core', '@marmeon/router', '@marmeon/auth', '@marmeon/database', '@marmeon/react']],
          ['Add when you need it', ['@marmeon/redis', '@marmeon/table', '@marmeon/otel']],
          ['Tooling', ['@marmeon/vite', '@marmeon/testing', '@marmeon/devtools']],
        ],
      ],
      ['Resources', [['Learn', ['Documentation', 'Installation', 'Upgrade Guide', 'A Resource With Its Policy']], ['Community', ['GitHub', 'GitHub Discussions', 'Releases and Support', 'Security Policy']]]],
    ]);
  });

  it('leaves out what the site does not have', () => {
    const text = JSON.stringify(panels());
    for (const missing of ['Blog', 'Guides', 'Discord']) expect(text, missing).not.toContain(missing);
  });

  it('points only at docs pages that exist, or leaves the site on purpose; the feature links too', () => {
    const targets = [...items().map(({ href, external, title }) => ({ href, external, title })), ...panels().map((panel) => ({ href: panel.feature.link.href, external: undefined, title: panel.feature.title }))];
    for (const { href, external, title } of targets) {
      if (external) expect(href, title).toMatch(/^https:\/\/github\.com\//);
      else expect(href === '/docs' || slugs.has(href.replace(/^\/docs\//, '')), `${title} → ${href}`).toBe(true);
    }
  });

  it('names a package page by the package and links the page that explains it', () => {
    expect(items().find((item) => item.title === '@marmeon/core')).toMatchObject({ href: '/docs/modules', text: PACKAGES.find((entry) => entry.name === '@marmeon/core')?.text });
  });

  it('computes the packages feature from the list', () => {
    const feature = panels().find((panel) => panel.id === 'packages')!.feature;
    expect(feature.title).toBe(`${PACKAGES.length} packages, one version.`);
    expect(feature.text).toContain(`${PACKAGES.filter((entry) => entry.group === 'app').length} of them`);
  });

  it.each([
    ['an item', 'why-marmeon'],
    ['a package page', 'routing'],
    ['the releases item', 'releases'],
    ['the security policy item', 'security-policy'],
    ['the packages feature link', 'packages'],
    ['the get-started feature link', 'installation'],
    ['the upgrade feature link', 'upgrading'],
  ])('stops when the docs page of %s is gone', (_kind, slug) => {
    expect(() => buildMenu(without(slug), PACKAGES)).toThrow(new RegExp(slug));
  });

  it('stops when a package the menu names is gone, or its docs page is not one', () => {
    expect(() => buildMenu(docs, PACKAGES.filter((entry) => entry.name !== '@marmeon/core'))).toThrow(/@marmeon\/core/);
    expect(() => buildMenu(docs, PACKAGES.map((entry) => (entry.name === '@marmeon/auth' ? { ...entry, docs: 'no-such-page' } : entry)))).toThrow(/no-such-page/);
  });
});

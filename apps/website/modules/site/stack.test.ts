import { describe, expect, it } from 'vitest';
import docs from '../../docs.config.ts';
import { PACKAGES } from './packages.ts';
import { buildStack, STACK_BATTERIES, STACK_LAYERS } from './stack.ts';

describe('the hero stack', () => {
  it('resolves the five layers in order and the eight chips to their package pages', () => {
    const stack = buildStack(docs, PACKAGES);
    expect(stack.layers.map((layer) => [layer.title, layer.href])).toEqual([
      ['Forms', '/docs/forms'],
      ['Pages', '/docs/pages'],
      ['Controllers', '/docs/controllers'],
      ['Queries', '/docs/queries'],
      ['Database', '/docs/migrations'],
    ]);
    expect(stack.layers.at(-1)).toMatchObject({ title: 'Database', href: '/docs/migrations' });
    expect(stack.above[0]).toEqual({ title: 'Auth', href: '/docs/authentication' });
    const names = [...STACK_BATTERIES.above, ...STACK_BATTERIES.below].map((chip) => chip.name);
    expect([...stack.above, ...stack.below].map((chip) => chip.href)).toEqual(names.map((name) => `/docs/${PACKAGES.find((entry) => entry.name === name)!.docs}`));
  });

  it('throws for a docs slug that the docs do not list', () => {
    const layers = [...STACK_LAYERS, { title: 'Ghost', note: 'None', docs: 'no-such-page' }];
    expect(() => buildStack(docs, PACKAGES, { layers, batteries: STACK_BATTERIES })).toThrow("the docs page 'no-such-page', which docs.config.ts does not list");
  });

  it('throws for a package that packages.ts does not list', () => {
    const batteries = { above: [{ name: '@marmeon/ghost', label: 'Ghost' }], below: [] };
    expect(() => buildStack(docs, PACKAGES, { layers: STACK_LAYERS, batteries })).toThrow("the package '@marmeon/ghost', which packages.ts does not list");
  });
});

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MenuItem, MenuPanel } from '../menu.ts';
import { SiteMenuGroups } from './SiteMenu.tsx';

const item = (title: string, href: string): MenuItem => ({ title, text: '', href, icon: 'doc', external: true });

describe('the phone menu groups', () => {
  it('shows a page that two columns of one panel name once, and leaves out a column that only repeats pages', () => {
    const panel: MenuPanel = {
      id: 'framework',
      label: 'Framework',
      columns: [
        { title: 'First', items: [item('One', 'https://a.test/one'), item('Two', 'https://a.test/two')] },
        { title: 'Repeats', items: [item('Two again', 'https://a.test/two')] },
        { title: 'Mixed', items: [item('One again', 'https://a.test/one'), item('Three', 'https://a.test/three')] },
      ],
      feature: { eyebrow: '', title: '', text: '', link: { text: '', href: '/' } },
    };
    const html = renderToStaticMarkup(<SiteMenuGroups panels={[panel]} />);
    expect([...html.matchAll(/class="site-menu-title">([^<]*)</g)].map((match) => match[1])).toEqual(['First', 'Mixed']);
    expect([...html.matchAll(/<a href="([^"]+)"/g)].map((match) => match[1])).toEqual(['https://a.test/one', 'https://a.test/two', 'https://a.test/three']);
  });
});

import { describe, expect, it } from 'vitest';
import { SearchIndex, type IndexedSection } from './search.ts';
import { groupByPage } from './search-groups.ts';

const section = (heading: string, text: string, code = ''): IndexedSection => ({ path: '/docs/cache', page: 'Cache', section: 'The Basics', heading, anchor: heading.toLowerCase().replaceAll(' ', '-'), text, code });

describe('the search index', () => {
  it('puts a sentence that names a word before code that uses it, however often the code does', () => {
    const index = new SearchIndex([
      section('Examples', 'Clearing the cache.', 'cache.flush();\ncache.flush();\ncache.flush();\ncache.flush();\ncache.flush();'),
      section('Clearing', 'flush() empties the store.'),
    ]);
    expect(index.search('flush').map((hit) => hit.heading)).toEqual(['Clearing', 'Examples']);
  });

  it('shows the code around the word when only the code has it', () => {
    const index = new SearchIndex([section('Examples', 'Clearing the cache.', 'await cache.flush();')]);
    expect(index.search('flush')[0]!.excerpt).toBe('await cache.flush();');
  });

  it('takes a heading of the words of a name for the name — only where the section uses it', () => {
    const index = new SearchIndex([
      section('Missed runs', 'A task with onOneServer() runs once, also after a pause; onOneServer() needs a shared cache.'),
      section('One server only', 'onOneServer() runs a task on one server.'),
      section('One server with Compose', 'Compose starts the containers.'),
    ]);
    const named = index.search('onOneServer').map((hit) => hit.heading);
    expect(named, JSON.stringify(named)).toEqual(['One server only', 'Missed runs']);
    // Typed in lower case, the name has no words to look for.
    expect(index.search('ononeserver').map((hit) => hit.heading)).toEqual(['Missed runs', 'One server only']);
  });
});

describe('grouping hits by page', () => {
  const hit = (page: string, heading: string, section = 'The Basics') => ({ href: `/docs/${page.toLowerCase()}#${heading.toLowerCase()}`, page, section, heading, excerpt: `${heading} text` });

  it('keeps the order of each page’s first hit and gathers the later hits of a page under it', () => {
    const groups = groupByPage([hit('Routing', 'Names'), hit('Forms', 'Fields', 'Frontend'), hit('Routing', 'Linking'), hit('Cache', 'Flush')]);
    expect(groups.map((group) => group.page)).toEqual(['Routing', 'Forms', 'Cache']);
    expect(groups[0]!.hits.map((entry) => entry.heading)).toEqual(['Names', 'Linking']);
  });

  it('names the page’s path without an anchor and its section', () => {
    const [group] = groupByPage([hit('Forms', 'Fields', 'Frontend')]);
    expect(group).toMatchObject({ page: 'Forms', href: '/docs/forms', section: 'Frontend' });
    expect(group!.hits[0]).toEqual({ heading: 'Fields', href: '/docs/forms#fields', excerpt: 'Fields text' });
  });

  it('is empty for no hits', () => {
    expect(groupByPage([])).toEqual([]);
  });
});

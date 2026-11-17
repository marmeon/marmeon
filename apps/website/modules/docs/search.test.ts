import { describe, expect, it } from 'vitest';
import { SearchIndex, type IndexedSection } from './search.ts';

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

describe('the search over the pages’ titles', () => {
  const page = (path: string, title: string, section = 'The Basics', late = false): IndexedSection => ({ path, page: title, section, heading: title, anchor: '', text: `About ${title}.`, code: '', late });
  const index = new SearchIndex([
    page('/docs/upgrading', 'Upgrade Guide', 'Prologue', true),
    page('/docs/routing', 'Routing'),
    { ...page('/docs/routing', 'Routing'), heading: 'Names', anchor: 'names' },
    page('/docs/rate-limiting', 'Rate Limiting', 'Digging Deeper'),
    page('/docs/cache', 'Cache', 'Digging Deeper'),
  ]);

  it('finds a page once, whatever its sections, by a part of a word in its title', () => {
    expect(index.pages('rout')).toEqual([{ href: '/docs/routing', page: 'Routing', section: 'The Basics' }]);
  });

  it('wants every word of the query in the title — the words in any order, case-insensitively', () => {
    expect(index.pages('LIMITING rate').map((hit) => hit.href)).toEqual(['/docs/rate-limiting']);
    expect(index.pages('rate cache')).toEqual([]);
    expect(index.pages('')).toEqual([]);
  });

  it('keeps the order of the docs and puts the record of changes last', () => {
    expect(index.pages('g').map((hit) => hit.href)).toEqual(['/docs/routing', '/docs/rate-limiting', '/docs/upgrading']);
  });

  it('looks in the title only: a word of the first heading or of the text finds nothing', () => {
    const odd = new SearchIndex([{ path: '/docs/mcp', page: 'MCP Server', section: 'Tools', heading: 'Introduction', anchor: 'introduction', text: 'Talks about tokens.', code: '' }]);
    expect(odd.pages('mcp')).toHaveLength(1);
    expect(odd.pages('introduction')).toEqual([]);
    expect(odd.pages('tokens')).toEqual([]);
  });

  it('counts the first 8 words of the query only, as the section search does', () => {
    const long = new SearchIndex([page('/docs/words', 'one two three four five six seven eight')]);
    expect(long.pages('one two three four five six seven eight')).toHaveLength(1);
    expect(long.pages('one two three four five six seven eight nine')).toHaveLength(1);
    expect(long.pages('nine one two three four five six seven eight')).toEqual([]);
  });

  it('gives at most the limit', () => {
    expect(index.pages('g', { limit: 2 }).map((hit) => hit.href)).toEqual(['/docs/routing', '/docs/rate-limiting']);
  });
});

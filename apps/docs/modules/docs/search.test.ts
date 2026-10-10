import { describe, expect, it } from 'vitest';
import { SearchIndex, type IndexedSection } from './search.ts';

const section = (heading: string, text: string, code = ''): IndexedSection => ({ path: '/docs/cache', page: 'Cache', heading, anchor: heading.toLowerCase().replaceAll(' ', '-'), text, code });

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

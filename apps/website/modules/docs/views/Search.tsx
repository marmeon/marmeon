import type { PageProps } from '@marmeon/http';
import { Head, Link, useLayer, useQueryState, useRoute } from '@marmeon/react';
import type { ReactNode } from 'react';
import type { SearchController } from '../controllers/SearchController.ts';
import { SearchFrame } from '../components/SearchFrame.tsx';
import { DESCRIPTIONS } from '../../site/descriptions.ts';
import { groupByPage } from '../search-groups.ts';

/**
 * `/docs/search?q=…`: typing reloads only the results (one partial reload per pause, replacing the history entry). Without
 * JavaScript the form is an ordinary GET form to the same URL. The router asks for it as a layer over the current page (the
 * results are live, so the layer has no submit button); a shared link or a reload shows the page.
 */
export default function Search({ results }: PageProps<SearchController>) {
  const [query, setQuery] = useQueryState('docs.search', { only: ['results'], debounce: 200, history: 'replace' });
  const route = useRoute();
  const { isLayer } = useLayer<SearchController>();
  const Title = isLayer ? 'h2' : 'h1';
  const terms = query.q.toLowerCase().split(/\s+/).filter(Boolean);
  const groups = groupByPage(results);
  const searched = query.q.trim() !== '';

  return (
    <div className="page search">
      <Head title={query.q ? `Search: ${query.q}` : 'Search'}>
        <meta name="description" content={DESCRIPTIONS.search} />
      </Head>
      <div className="search-main">
        <Title className="visually-hidden">Search</Title>
        <form className="search-form" method="get" action={route('docs.search')} role="search" onSubmit={(event) => event.preventDefault()}>
          <label htmlFor="search-q">Search the docs</label>
          <div className="search-row">
            <div className="search-field">
              <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="7" cy="7" r="4.5" />
                <path d="M10.5 10.5L14 14" />
              </svg>
              <input
                id="search-q"
                type="search"
                name="q"
                value={query.q}
                maxLength={100}
                onChange={(event) => setQuery({ q: event.target.value })}
                placeholder="onOneServer, TracingChannel, useForm …"
                autoFocus
              />
            </div>
            {isLayer ? null : (
              <button type="submit" className="button search-submit">
                Search
              </button>
            )}
          </div>
        </form>
        <p className="search-status" role="status">
          {!searched
            ? 'Words are found on every page, as parts of words, all of them in one section.'
            : results.length === 0
              ? `Nothing found for “${query.q}”.`
              : `${results.length} ${results.length === 1 ? 'result' : 'results'} on ${groups.length} ${groups.length === 1 ? 'page' : 'pages'} for “${query.q}”`}
        </p>
        {groups.map((group) => (
          <section key={group.href} className="search-group" aria-label={group.page}>
            <h2>
              <Link href={group.href} prefetch>
                {group.page}
              </Link>
              <span className="visually-hidden"> – </span>
              <span className="search-section">{group.section}</span>
            </h2>
            <ul>
              {group.hits.map((hit) => (
                <li key={hit.href}>
                  <Link className="search-hit" href={hit.href} prefetch>
                    <span className="search-hit-heading">
                      <span aria-hidden="true">#</span>
                      {hit.heading}
                    </span>
                    <span className="search-hit-excerpt">{highlight(hit.excerpt, terms)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
        <p className="search-note">
          Results come from the server and work without JavaScript. Press <kbd>/</kbd> on any page to search.
        </p>
      </div>
    </div>
  );
}

Search.layer = SearchFrame;

/** The terms of the query marked in the excerpt. */
function highlight(text: string, terms: readonly string[]): ReactNode[] {
  if (terms.length === 0) return [text];
  const pattern = new RegExp(`(${terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return text.split(pattern).map((part, index) => (index % 2 === 1 ? <mark key={index}>{part}</mark> : part));
}

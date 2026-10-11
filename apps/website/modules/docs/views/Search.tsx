import type { PageProps } from '@marmeon/http';
import { Head, Link, useQueryState, useRoute } from '@marmeon/react';
import type { ReactNode } from 'react';
import type { SearchController } from '../controllers/SearchController.ts';

/**
 * `/docs/search?q=…`: typing reloads only the results (one partial reload per pause, replacing the history entry). Without
 * JavaScript the form is an ordinary GET form to the same URL.
 */
export default function Search({ results }: PageProps<SearchController>) {
  const [query, setQuery] = useQueryState('docs.search', { only: ['results'], debounce: 200, history: 'replace' });
  const route = useRoute();
  const terms = query.q.toLowerCase().split(/\s+/).filter(Boolean);

  return (
    <div className="page search">
      <Head title={query.q ? `Search: ${query.q}` : 'Search'} />
      <article className="doc">
        <h1>Search</h1>
        <form method="get" action={route('docs.search')} role="search" onSubmit={(event) => event.preventDefault()}>
          <input
            type="search"
            name="q"
            value={query.q}
            maxLength={100}
            onChange={(event) => setQuery({ q: event.target.value })}
            placeholder="onOneServer, TracingChannel, useForm …"
            aria-label="Search the docs"
            autoFocus
          />
        </form>
        {query.q.trim() === '' ? (
          <p className="muted">Words are found on every page — as parts of words, all of them in one section.</p>
        ) : results.length === 0 ? (
          <p className="muted">Nothing found for “{query.q}”.</p>
        ) : (
          <ol className="results">
            {results.map((result) => (
              <li key={result.href}>
                <Link href={result.href} prefetch>
                  <span className="result-page">{result.page}</span>
                  {result.heading && result.heading !== result.page && <span className="result-heading"> › {result.heading}</span>}
                </Link>
                <p>{highlight(result.excerpt, terms)}</p>
              </li>
            ))}
          </ol>
        )}
      </article>
    </div>
  );
}

/** The terms of the query marked in the excerpt. */
function highlight(text: string, terms: readonly string[]): ReactNode[] {
  if (terms.length === 0) return [text];
  const pattern = new RegExp(`(${terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return text.split(pattern).map((part, index) => (index % 2 === 1 ? <mark key={index}>{part}</mark> : part));
}

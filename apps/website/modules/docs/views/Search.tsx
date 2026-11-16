import type { PageProps } from '@marmeon/http';
import { Head, Link, useLayer, usePage, useQueryState, useRoute } from '@marmeon/react';
import { useEffect, useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { SearchController } from '../controllers/SearchController.ts';
import { SEARCH_SCOPES, type SearchScope } from '../search.ts';
import { SearchFrame } from '../components/SearchFrame.tsx';
import { START } from '../components/start-pages.tsx';
import { useHydrated } from '../../site/components/useHydrated.ts';
import { DESCRIPTIONS } from '../../site/descriptions.ts';

const SCOPE_LABELS: Record<SearchScope, string> = { all: 'Everything', pages: 'Pages', sections: 'Sections on a page' };

/** One selectable row: a link with a title, a line under it and — for a section — the excerpt. */
interface Row {
  readonly id: string;
  readonly href: string;
  readonly title: string;
  readonly meta: string;
  readonly excerpt?: string;
}

interface Group {
  readonly title: string;
  readonly rows: readonly Row[];
}

/**
 * `/docs/search?q=…&scope=…`: typing reloads only the results (one partial reload per pause, replacing the history entry). Without
 * JavaScript the form is an ordinary GET form to the same URL — the scopes are radio buttons of it — and the results are plain links.
 * Hydrated, the field is a combobox over the results (↑ ↓ Home End move, ↵ opens). The router asks for it as a layer over the current
 * page (the results are live, so the layer has no submit button); a shared link or a reload shows the page.
 */
export default function Search({ results }: PageProps<SearchController>) {
  const [query, setQuery] = useQueryState('docs.search', { only: ['results'], debounceMs: 200, history: 'replace' });
  const route = useRoute();
  const { isLayer } = useLayer<SearchController>();
  const hydrated = useHydrated();
  const version = usePage().props.site?.version;
  const Title = isLayer ? 'h2' : 'h1';
  const GroupTitle = isLayer ? 'h3' : 'h2';
  const terms = query.q.toLowerCase().split(/\s+/).filter(Boolean);
  // The list is for `results.q` and `results.scope`; the field and the scope change at once, the answer a pause and a round trip later.
  const pending = results.q !== query.q.trim() || results.scope !== query.scope;
  const searched = results.q !== '';
  // Ids of the document the layer sits over (heading anchors of a docs page) never collide with these.
  const uid = useId();

  const groups = groupsOf(searched, results, uid);
  const rows = groups.flatMap((group) => group.rows);
  // The active row: the first one, again whenever what is listed changes.
  const signature = rows.map((row) => row.href).join('|');
  const [chosen, choose] = useState({ signature, index: 0 });
  const active = Math.min(chosen.signature === signature ? chosen.index : 0, rows.length - 1);
  const move = (index: number) => choose({ signature, index: Math.max(0, Math.min(rows.length - 1, index)) });
  const activeId = hydrated && !pending && rows.length > 0 ? rows[active]!.id : undefined;
  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeId]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || rows.length === 0) return;
    const typed = event.key === 'Enter';
    const to = { ArrowDown: active + 1, ArrowUp: active - 1, Home: 0, End: rows.length - 1 }[event.key];
    if (to !== undefined) {
      event.preventDefault();
      move(to);
    } else if (typed) {
      event.preventDefault();
      // The list is the previous query's while an answer is on its way: opening one of its hits would open the wrong page.
      if (!pending) document.getElementById(rows[active]!.id)?.click();
    }
  };

  const count = pending ? 'Searching…' : !searched ? 'Type to search' : `${rows.length} ${rows.length === 1 ? 'result' : 'results'}`;
  let number = 0;

  return (
    <div className="page search">
      <Head title={query.q ? `Search: ${query.q}` : 'Search'}>
        <meta name="description" content={DESCRIPTIONS.search} />
      </Head>
      <div className="search-main">
        <Title className="visually-hidden">Search</Title>
        <form className="search-form" method="get" action={route('docs.search')} role="search" onSubmit={(event) => event.preventDefault()}>
          <label htmlFor={`${uid}-q`} className="visually-hidden">
            Search the docs
          </label>
          <div className="search-row">
            <div className="search-field">
              <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2.2">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
              <input
                id={`${uid}-q`}
                data-search-field
                type="search"
                name="q"
                value={query.q}
                maxLength={100}
                autoComplete="off"
                onChange={(event) => setQuery({ q: event.target.value })}
                placeholder="Search routes, policies, queues…"
                autoFocus
                {...(hydrated
                  ? {
                      role: 'combobox',
                      'aria-controls': `${uid}-results`,
                      'aria-expanded': rows.length > 0,
                      'aria-autocomplete': 'list' as const,
                      'aria-activedescendant': activeId,
                      onKeyDown,
                    }
                  : {})}
              />
              {hydrated && isLayer && <kbd aria-hidden="true">esc</kbd>}
            </div>
            {isLayer ? null : (
              <button type="submit" className="button search-submit">
                Search
              </button>
            )}
          </div>
          <div className="search-scopes">
            <fieldset>
              <legend className="visually-hidden">Search in</legend>
              {SEARCH_SCOPES.map((scope) => (
                <label key={scope} className="search-chip">
                  <input type="radio" name="scope" value={scope} checked={query.scope === scope} onChange={() => setQuery({ scope })} />
                  <span>{SCOPE_LABELS[scope]}</span>
                </label>
              ))}
            </fieldset>
            {version && <span className="search-version">{version}</span>}
          </div>
        </form>
        <div id={`${uid}-results`} className="search-results" {...(hydrated ? { role: 'listbox', 'aria-label': 'Results' } : {})}>
          {!pending && searched && rows.length === 0 && (
            <div className="search-empty">
              <p className="search-empty-title">{`Nothing found for “${results.q}”.`}</p>
              <p>Try fewer words, or a package name such as queue or auth.</p>
            </div>
          )}
          {groups.map((group, groupIndex) => (
            <section
              key={group.title}
              className="search-group"
              aria-labelledby={hydrated ? undefined : `${uid}-group-${groupIndex}`}
              {...(hydrated ? { role: 'group', 'aria-label': group.title } : {})}
            >
              <GroupTitle id={`${uid}-group-${groupIndex}`} className="search-group-title" aria-hidden={hydrated ? true : undefined}>
                {group.title}
              </GroupTitle>
              <ul role={hydrated ? 'presentation' : undefined}>
                {group.rows.map((row) => {
                  const index = number++;
                  const selected = hydrated && !pending && index === active;
                  return (
                    <li key={row.id} role={hydrated ? 'presentation' : undefined}>
                      <Link
                        href={row.href}
                        prefetch
                        id={row.id}
                        className="search-hit"
                        role={hydrated ? 'option' : undefined}
                        aria-selected={hydrated ? selected : undefined}
                        tabIndex={hydrated ? -1 : undefined}
                        onMouseMove={hydrated && index !== active ? () => move(index) : undefined}
                      >
                        <span className="search-hit-title">{highlight(row.title, terms)}</span>
                        <span className="search-hit-meta">{row.meta}</span>
                        {row.excerpt && <span className="search-hit-excerpt">{highlight(row.excerpt, terms)}</span>}
                        {selected && (
                          <span className="search-hit-enter" aria-hidden="true">
                            ↵
                          </span>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
        <footer className="search-foot">
          {hydrated && (
            <span className="search-keys" aria-hidden="true">
              <span>
                <kbd>↑</kbd>
                <kbd>↓</kbd>move
              </span>
              <span>
                <kbd>↵</kbd>open
              </span>
              {isLayer && (
                <span>
                  <kbd>esc</kbd>close
                </span>
              )}
            </span>
          )}
          <span className="search-count" role="status">
            {count}
          </span>
        </footer>
        {isLayer ? null : (
          <p className="search-note">
            Results come from the server and work without JavaScript. Press <kbd>⌘K</kbd> or <kbd>Ctrl K</kbd> on any docs page to search.
          </p>
        )}
      </div>
    </div>
  );
}

Search.layer = SearchFrame;

/** What the list shows: the start pages for an empty query; else the pages by title, then the sections by text. */
function groupsOf(searched: boolean, results: PageProps<SearchController>['results'], uid: string): Group[] {
  if (!searched) {
    return [{ title: 'Where to start', rows: START.map((page, index) => ({ id: `${uid}-option-${index}`, href: page.path, title: page.label, meta: page.section })) }];
  }
  let at = 0;
  const id = () => `${uid}-option-${at++}`;
  const groups: Group[] = [];
  if (results.pages.length > 0) groups.push({ title: 'Pages', rows: results.pages.map((page) => ({ id: id(), href: page.href, title: page.page, meta: page.section })) });
  if (results.sections.length > 0) {
    groups.push({
      title: 'On a page',
      rows: results.sections.map((hit) => ({ id: id(), href: hit.href, title: hit.heading || hit.page, meta: `${hit.page} › ${hit.section}`, excerpt: hit.excerpt })),
    });
  }
  return groups;
}

/** The terms of the query marked in the text. */
function highlight(text: string, terms: readonly string[]): ReactNode[] {
  if (terms.length === 0) return [text];
  const pattern = new RegExp(`(${terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return text.split(pattern).map((part, index) => (index % 2 === 1 ? <mark key={index}>{part}</mark> : part));
}

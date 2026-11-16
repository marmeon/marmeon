import type { TocEntry } from '../types.ts';

function Entries({ entries }: { entries: readonly TocEntry[] }) {
  return (
    <ul>
      {entries.map((entry) => (
        <li key={entry.id} className={entry.depth === 3 ? 'sub' : undefined}>
          <a href={`#${entry.id}`}>{entry.text}</a>
        </li>
      ))}
    </ul>
  );
}

/**
 * "On this page": the H2 and H3 of the page as anchors — the browser scrolls, no visit. The column beside the page. A newest page
 * (`slug`) adds how an agent reads it in the version it runs: the `docs_read` tool of the MCP server (`marmeon mcp`), which takes
 * the slug. A page without headings still carries that block.
 */
export function Toc({ entries, slug }: { entries: readonly TocEntry[]; slug?: string }) {
  if (entries.length === 0 && !slug) return null;
  return (
    <aside className="toc" aria-labelledby={entries.length > 0 ? 'toc-title' : undefined} aria-label={entries.length > 0 ? undefined : 'For your agent'}>
      {entries.length > 0 && (
        <>
          <p id="toc-title" className="toc-title">
            On this page
          </p>
          <Entries entries={entries} />
        </>
      )}
      {slug && (
        <div className="toc-agent">
          <p className="toc-agent-title">For your agent</p>
          <p>Your agent reads this page with the docs_read tool of marmeon mcp:</p>
          <code>{`docs_read { "page": "${slug}" }`}</code>
        </div>
      )}
    </aside>
  );
}

/** The same list for a phone, above the text and folded: a `<details>` that needs no JavaScript. */
export function TocMobile({ entries }: { entries: readonly TocEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <details className="toc-mobile">
      <summary>
        On this page
        <span className="nav-sign" aria-hidden="true" />
      </summary>
      <nav aria-label="On this page">
        <Entries entries={entries} />
      </nav>
    </details>
  );
}

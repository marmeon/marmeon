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

/** "On this page": the H2 and H3 of the page as anchors — the browser scrolls, no visit. The column beside the page. */
export function Toc({ entries }: { entries: readonly TocEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <aside className="toc" aria-labelledby="toc-title">
      <p id="toc-title" className="toc-title">
        On this page
      </p>
      <Entries entries={entries} />
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

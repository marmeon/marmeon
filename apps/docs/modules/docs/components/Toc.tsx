import type { TocEntry } from '../types.ts';

/** "On this page": the H2 and H3 of the page as anchors — the browser scrolls, no visit. */
export function Toc({ entries }: { entries: readonly TocEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <aside className="toc" aria-labelledby="toc-title">
      <p id="toc-title" className="toc-title">
        On this page
      </p>
      <ul>
        {entries.map((entry) => (
          <li key={entry.id} className={entry.depth === 3 ? 'sub' : undefined}>
            <a href={`#${entry.id}`}>{entry.text}</a>
          </li>
        ))}
      </ul>
    </aside>
  );
}

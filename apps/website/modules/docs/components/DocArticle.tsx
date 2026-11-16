import { Link } from '@marmeon/react';
import type { ReactNode } from 'react';
import type { TocEntry, DocNode } from '../types.ts';
import { roman } from '../roman.ts';
import { CopyPageButton } from './CopyPageButton.tsx';
import { Markdown } from './Markdown.tsx';
import { Toc, TocMobile } from './Toc.tsx';

interface PageLink {
  readonly path: string;
  readonly title: string;
  readonly section: string;
}

/**
 * A page of the docs — newest or of a release line: the breadcrumb and the ways to take the page along, its section's number, the
 * title, the packages it documents, its table of contents, the text and the pager. `children` come first (a banner). `home` is
 * where "Docs" leads (a release line's own start page). `slug` marks a newest page (it carries the agent's call beside the table
 * of contents). `sectionNumber` comes from the page's own navigation (a line's pages use the line's); `packages` come from the
 * newest pages only.
 */
export function DocArticle({ home = '/docs', slug, title, section, sectionNumber, packages = [], body, toc, markdown, previous, next, children }: { home?: string; slug?: string; title: string; section: string; sectionNumber?: number; packages?: readonly string[]; body: DocNode[]; toc: TocEntry[]; markdown: string; previous: PageLink | null; next: PageLink | null; children?: ReactNode }) {
  return (
    <div className="page doc-page">
      {children}
      <article className="doc">
        <div className="doc-kicker">
          <nav aria-label="Breadcrumb">
            <ol>
              <li>
                <Link href={home}>Docs</Link>
              </li>
              <li>{section}</li>
              <li aria-current="page">{title}</li>
            </ol>
          </nav>
          <div className="doc-actions">
            {/* A plain link, not `<Link>`: the answer is no page, the browser opens it. */}
            <a className="doc-source" href={markdown} type="text/markdown">
              <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 6h18v12H3zM6 15V9l2.5 3L11 9v6M15 12l2 3 2-3M17 9v6" />
              </svg>
              View as Markdown
            </a>
            <CopyPageButton key={markdown} markdown={markdown} />
          </div>
        </div>
        <p className="doc-eyebrow">{sectionNumber ? `${roman(sectionNumber)} · ${section}` : section}</p>
        <h1>{title}</h1>
        {packages.length > 0 && (
          <ul className="doc-packages" aria-label="Packages">
            {packages.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        )}
        <TocMobile entries={toc} />
        <div className="doc-body">
          <Markdown nodes={body} />
        </div>
        <nav className="pager" aria-label="More pages">
          {previous ? (
            <Link href={previous.path} prefetch rel="prev">
              <span className="pager-label"><span aria-hidden="true">← </span>Previous · {previous.section}</span>
              <span className="pager-title">{previous.title}</span>
            </Link>
          ) : (
            <span />
          )}
          {next && (
            <Link href={next.path} prefetch rel="next">
              <span className="pager-label">Next · {next.section}<span aria-hidden="true"> →</span></span>
              <span className="pager-title">{next.title}</span>
            </Link>
          )}
        </nav>
      </article>
      <Toc entries={toc} slug={slug} />
    </div>
  );
}

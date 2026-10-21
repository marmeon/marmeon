import { Link } from '@marmeon/react';
import type { ReactNode } from 'react';
import type { TocEntry, DocNode } from '../types.ts';
import { Markdown } from './Markdown.tsx';
import { Toc, TocMobile } from './Toc.tsx';

interface PageLink {
  readonly path: string;
  readonly title: string;
  readonly section: string;
}

/** A page of the docs — newest or of a release line: the title, its table of contents, the text and the pager. `children` come first (a banner). */
export function DocArticle({ title, section, body, toc, markdown, previous, next, children }: { title: string; section: string; body: DocNode[]; toc: TocEntry[]; markdown: string; previous: PageLink | null; next: PageLink | null; children?: ReactNode }) {
  return (
    <div className="page doc-page">
      {children}
      <article className="doc">
        <div className="doc-kicker">
          <p className="eyebrow">{section}</p>
          {/* A plain link, not `<Link>`: the answer is no page, the browser opens it. */}
          <a className="doc-source" href={markdown} type="text/markdown">
            View as Markdown
          </a>
        </div>
        <h1>{title}</h1>
        <TocMobile entries={toc} />
        <Markdown nodes={body} />
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
      <Toc entries={toc} />
    </div>
  );
}

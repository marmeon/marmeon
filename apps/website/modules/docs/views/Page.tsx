import type { PageProps } from '@marmeon/http';
import { Head, Link } from '@marmeon/react';
import type { ShowDocController } from '../controllers/ShowDocController.ts';
import { Markdown } from '../components/Markdown.tsx';
import { Toc, TocMobile } from '../components/Toc.tsx';

/** `/docs/:page`: a page of the docs. */
export default function Page({ title, section, body, toc, previous, next }: PageProps<ShowDocController>) {
  return (
    <div className="page doc-page">
      <Head title={title} />
      <article className="doc">
        <p className="eyebrow">{section}</p>
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

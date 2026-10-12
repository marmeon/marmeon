import type { PageProps } from '@marmeon/http';
import { Link } from '@marmeon/react';
import type { ShowDocController } from '../controllers/ShowDocController.ts';
import { Markdown } from '../components/Markdown.tsx';
import { SiteHead } from '../../site/components/SiteHead.tsx';
import { Toc, TocMobile } from '../components/Toc.tsx';

/** `/docs/:page`: a page of the docs. */
export default function Page({ title, section, body, toc, description, path, markdown, previous, next }: PageProps<ShowDocController>) {
  return (
    <div className="page doc-page">
      <SiteHead title={title} description={description} path={path} type="article">
        <link rel="alternate" type="text/markdown" href={markdown} />
      </SiteHead>
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

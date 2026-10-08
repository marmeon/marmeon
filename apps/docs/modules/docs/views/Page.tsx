import type { PageProps } from '@marmeon/http';
import { Head, Link } from '@marmeon/react';
import type { ShowPackageController } from '../controllers/ShowPackageController.ts';
import { Markdown } from '../components/Markdown.tsx';
import { Toc } from '../components/Toc.tsx';

/** `/docs/:page` and `/packages/:name`: a page of the docs or a package's README. */
export default function Page({ title, section, body, toc, previous, next }: PageProps<ShowPackageController>) {
  return (
    <div className="page">
      <Head title={title} />
      <article className="doc">
        <p className="eyebrow">{section}</p>
        <h1>{title}</h1>
        <Markdown nodes={body} />
        <nav className="pager" aria-label="More pages">
          {previous ? (
            <Link href={previous.path} prefetch rel="prev">
              <small>Previous</small> {previous.title}
            </Link>
          ) : (
            <span />
          )}
          {next && (
            <Link href={next.path} prefetch rel="next">
              <small>Next</small> {next.title}
            </Link>
          )}
        </nav>
      </article>
      <Toc entries={toc} />
    </div>
  );
}

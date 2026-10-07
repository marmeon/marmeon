import type { PageProps } from '@marmeon/http';
import { Head, Link } from '@marmeon/react';
import type { ShowPackageController } from '../controllers/ShowPackageController.ts';
import { Markdown } from '../components/Markdown.tsx';
import { Toc } from '../components/Toc.tsx';

/** `/packages/:name` and `/guides/:guide`: a package's README or a guide. */
export default function Page({ title, group, body, toc, previous, next }: PageProps<ShowPackageController>) {
  return (
    <div className="page">
      <Head title={title} />
      <article className="doc">
        {group && <p className="eyebrow">{group}</p>}
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

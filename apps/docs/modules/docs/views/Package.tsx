import type { PageProps } from '@bespokecore/http';
import { Head, Link } from '@bespokecore/react';
import type { ShowPackageController } from '../controllers/ShowPackageController.ts';
import { Markdown } from '../components/Markdown.tsx';
import { Toc } from '../components/Toc.tsx';

/** `/packages/:name`: a package's README. */
export default function Package({ title, group, body, toc, previous, next }: PageProps<ShowPackageController>) {
  return (
    <div className="page">
      <Head title={title} />
      <article className="doc">
        {group && <p className="eyebrow">{group}</p>}
        <h1>{title}</h1>
        <Markdown nodes={body} />
        <nav className="pager" aria-label="More packages">
          {previous ? (
            <Link route="docs.package" params={{ name: previous.name }} prefetch rel="prev">
              <small>Previous</small> {previous.title}
            </Link>
          ) : (
            <span />
          )}
          {next && (
            <Link route="docs.package" params={{ name: next.name }} prefetch rel="next">
              <small>Next</small> {next.title}
            </Link>
          )}
        </nav>
      </article>
      <Toc entries={toc} />
    </div>
  );
}

import type { PageProps } from '@bespokecore/http';
import { Head } from '@bespokecore/react';
import type { ShowHomeController } from '../controllers/ShowHomeController.ts';
import { Markdown } from '../components/Markdown.tsx';
import { Toc } from '../components/Toc.tsx';

/** `/`: the repository's README. */
export default function Home({ title, body, toc }: PageProps<ShowHomeController>) {
  return (
    <div className="page">
      <Head title="" />
      <article className="doc">
        <h1>{title}</h1>
        <Markdown nodes={body} />
      </article>
      <Toc entries={toc} />
    </div>
  );
}

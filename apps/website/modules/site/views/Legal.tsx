import type { PageProps } from '@marmeon/http';
import { Head } from '@marmeon/react';
import { Markdown } from '../../docs/components/Markdown.tsx';
import type { ShowImprintController } from '../controllers/ShowImprintController.ts';

/** `/imprint` and `/privacy`: a text from `content/legal/` in the docs' typography. */
export default function Legal({ title, body }: PageProps<ShowImprintController>) {
  return (
    <div className="legal-page">
      <Head title={title} />
      <article className="doc">
        <h1>{title}</h1>
        <Markdown nodes={body} />
      </article>
    </div>
  );
}

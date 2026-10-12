import type { PageProps } from '@marmeon/http';
import { Markdown } from '../../docs/components/Markdown.tsx';
import { SiteHead } from '../components/SiteHead.tsx';
import type { ShowImprintController } from '../controllers/ShowImprintController.ts';

/** `/imprint` and `/privacy`: a text from `content/legal/` in the docs' typography. */
export default function Legal({ title, body, description, path }: PageProps<ShowImprintController>) {
  return (
    <div className="legal-page">
      <SiteHead title={title} description={description} path={path} />
      <article className="doc">
        <h1>{title}</h1>
        <Markdown nodes={body} />
      </article>
    </div>
  );
}

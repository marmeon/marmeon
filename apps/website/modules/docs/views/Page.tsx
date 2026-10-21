import type { PageProps } from '@marmeon/http';
import type { ShowDocController } from '../controllers/ShowDocController.ts';
import { DocArticle } from '../components/DocArticle.tsx';
import { SiteHead } from '../../site/components/SiteHead.tsx';

/** `/docs/:page`: a page of the docs. */
export default function Page({ title, section, body, toc, description, path, markdown, previous, next }: PageProps<ShowDocController>) {
  return (
    <>
      <SiteHead title={title} description={description} path={path} type="article">
        <link rel="alternate" type="text/markdown" href={markdown} />
      </SiteHead>
      <DocArticle title={title} section={section} body={body} toc={toc} markdown={markdown} previous={previous} next={next} />
    </>
  );
}

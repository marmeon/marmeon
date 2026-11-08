import type { PageProps } from '@marmeon/http';
import type { ShowLineDocController } from '../controllers/ShowLineDocController.ts';
import { DocArticle } from '../components/DocArticle.tsx';
import { LineBanner } from '../components/LineBanner.tsx';
import { docsNodes } from '../../site/structured-data.ts';
import { SiteHead } from '../../site/components/SiteHead.tsx';

/** `/docs/<line>/<page>`: a page of a release line — not indexed, with the newest version of the page as canonical. */
export default function LinePage({ title, section, body, toc, description, path, newest, markdown, line, previous, next }: PageProps<ShowLineDocController>) {
  return (
    <>
      <SiteHead title={`${title} (${line.name})`} description={description} path={newest} type="article" noindex nodes={(site) => docsNodes(site, { title: `${title} (${line.name})`, description, path: newest, own: path, version: line.version, line: line.name })}>
        <link rel="alternate" type="text/markdown" href={markdown} />
      </SiteHead>
      <DocArticle title={title} section={section} body={body} toc={toc} markdown={markdown} previous={previous} next={next}>
        <LineBanner line={line} newest={newest} />
      </DocArticle>
    </>
  );
}

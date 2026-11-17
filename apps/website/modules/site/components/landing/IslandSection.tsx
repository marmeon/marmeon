import type { PageProps } from '@marmeon/http';
import { Island } from '@marmeon/react';
import type { ShowLandingController } from '../../controllers/ShowLandingController.ts';
import { Editor } from '../Editor.tsx';

const clock = (
  <Island
    route="site.render-clock"
    load="visible"
    pollMs={10_000}
    fallback={<p className="island-fallback">With JavaScript, the browser loads an island here: a part of the page the server renders on its own.</p>}
    className="island-frame"
  />
);

/** "A part of the page that loads on its own": the island's controller and the element that loads it, with the island itself under them. */
export function IslandSection({ snippets }: Pick<PageProps<ShowLandingController>, 'snippets'>) {
  return (
    <section className="islands duo-card" aria-labelledby="islands-title">
      <p className="section-label">Islands</p>
      <h2 id="islands-title">
        A part of the page <span className="serif-accent">that loads on its own.</span>
      </h2>
      <p>
        An island is the view of another route, with its own controller, middleware and query. The one under the code is live: the server renders it, and the browser reloads only this region every ten seconds.
      </p>
      <Editor
        label="The island's controller and the element that loads it"
        headingLevel={3}
        files={[
          { name: snippets.islandController.file!.split('/').at(-1)!, html: snippets.islandController.html },
          { name: snippets.islandPage.file!.split('/').at(-1)!, html: snippets.islandPage.html },
        ]}
      />
      <div className="island-stage">{clock}</div>
    </section>
  );
}

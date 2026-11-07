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

/** "A part of the page that loads on its own": the island's controller and the element that loads it, beside the island itself. */
export function IslandSection({ snippets }: Pick<PageProps<ShowLandingController>, 'snippets'>) {
  return (
    <section className="islands" aria-labelledby="islands-title">
      <div className="landing-inner">
        <div className="section-intro section-intro--wide">
          <p className="section-label">Islands</p>
          <h2 id="islands-title">A part of the page that loads on its own.</h2>
          <p>
            An island is the view of another route, with its own controller, middleware and query. The one next to the code is live: the server renders it, and the browser reloads only this region every ten
            seconds.
          </p>
        </div>
        <div className="landing-columns island-columns">
          <Editor
            label="The island's controller and the element that loads it"
            headingLevel={3}
            files={[
              { name: snippets.islandController.file!.split('/').at(-1)!, html: snippets.islandController.html },
              { name: snippets.islandPage.file!.split('/').at(-1)!, html: snippets.islandPage.html },
            ]}
          />
          <div className="island-stage">{clock}</div>
        </div>
      </div>
    </section>
  );
}

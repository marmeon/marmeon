import { Link } from '@marmeon/react';
import { DevtoolsReplica } from './DevtoolsReplica.tsx';

/** "See what a request did": a copy of the devtools with sample data. Its link sits outside the figure; the figure holds none. */
export function DevtoolsSection() {
  return (
    <section className="devtools" aria-labelledby="devtools-title">
      <div className="landing-inner">
        <div className="band-frame">
          <div className="band-head">
            <div>
              <p className="section-label">Devtools</p>
              <h2 id="devtools-title">
                See what a request <span className="serif-accent">did.</span>
              </h2>
            </div>
            <p>
              Requests, queries, jobs and mails, recorded in development with secrets redacted, in a bar on every page and on a page of its own. Production has none of it. Try the copy below; its data is invented.{' '}
              <Link href="/docs/devtools">Read the devtools page</Link>
            </p>
          </div>
          <DevtoolsReplica />
        </div>
      </div>
    </section>
  );
}

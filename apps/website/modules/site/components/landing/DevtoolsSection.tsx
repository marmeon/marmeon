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
              In development, devtools records requests, queries, jobs and mails and shows them on a page of its own and in a bar on every page. Secrets are redacted. In production it is not there. The picture
              below is a copy with invented data; click through its tabs. <Link href="/docs/devtools">Read the devtools page</Link>
            </p>
          </div>
          <DevtoolsReplica />
        </div>
      </div>
    </section>
  );
}

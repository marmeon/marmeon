import { Link } from '@marmeon/react';
import { DevtoolsReplica } from './DevtoolsReplica.tsx';

/** "See what a request did": a copy of the devtools with sample data. Its link sits outside the figure; the figure holds none. */
export function DevtoolsSection() {
  return (
    <section className="devtools" aria-labelledby="devtools-title">
      <div className="landing-inner">
        <div className="section-intro section-intro--wide">
          <p className="section-label">Devtools</p>
          <h2 id="devtools-title">See what a request did.</h2>
          <p>
            In development, devtools records requests, queries, jobs and mails and shows them on a page of its own and in a bar on every page. Secrets are redacted. In production it is not there. The picture below is a copy with invented data; click through its tabs. <Link href="/docs/devtools">Read the devtools page</Link>
          </p>
        </div>
        <DevtoolsReplica />
      </div>
    </section>
  );
}

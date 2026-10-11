import { Mark } from '../Mark.tsx';

const SECTIONS = ['Requests', 'Queries', 'Jobs', 'Mails'];
const REQUESTS: { method: string; path: string; route: string; status: string; selected?: boolean; failed?: boolean }[] = [
  { method: 'POST', path: '/notes', route: 'notes.store', status: '302', selected: true },
  { method: 'GET', path: '/notes', route: 'notes.index', status: '200' },
  { method: 'GET', path: '/notes/12', route: 'notes.show', status: '200' },
  { method: 'GET', path: '/notes/99', route: 'notes.show', status: '404', failed: true },
];

/** "See what a request did": a static picture of the devtools, drawn in markup. Nothing in it is a link, a control or a measurement. */
export function DevtoolsSection() {
  return (
    <section className="devtools" aria-labelledby="devtools-title">
      <div className="landing-inner">
        <div className="section-intro section-intro--wide">
          <p className="section-label">Devtools</p>
          <h2 id="devtools-title">See what a request did.</h2>
          <p>
            In development, devtools records requests, queries, jobs and mails at <code>/_marmeon/devtools</code>. Secrets are masked. In production it is not
            there.
          </p>
        </div>
        <figure className="devtools-panel" aria-label="Devtools panel, illustration">
          <div className="devtools-bar" aria-hidden="true">
            <Mark size={16} />
            <span>localhost:3000/_marmeon/devtools</span>
            <span className="devtools-env">DEVELOPMENT</span>
          </div>
          <div className="devtools-body" aria-hidden="true">
            <ul className="devtools-nav">
              {SECTIONS.map((section, index) => (
                <li key={section} className={index === 0 ? 'is-current' : undefined}>
                  {section}
                </li>
              ))}
            </ul>
            <div className="devtools-list">
              <div className="devtools-row devtools-row--head">
                <span>METHOD</span>
                <span>PATH · ROUTE</span>
                <span>STATUS</span>
              </div>
              {REQUESTS.map(({ method, path, route, status, selected, failed }) => (
                <div key={`${method} ${path}`} className={selected ? 'devtools-row is-current' : 'devtools-row'}>
                  <span className="devtools-method">{method}</span>
                  <span>
                    {path} <span className="devtools-route">{route}</span>
                  </span>
                  <span className={failed ? 'devtools-failed' : undefined}>{status}</span>
                </div>
              ))}
            </div>
            <div className="devtools-detail">
              <p className="devtools-title">
                <strong>POST /notes</strong>
                <span>StoreNoteController · 302</span>
              </p>
              <dl>
                <dt>form.title</dt>
                <dd>&quot;Groceries&quot;</dd>
                <dt>form.body</dt>
                <dd>&quot;Milk&quot;</dd>
                <dt>Cookie</dt>
                <dd className="devtools-masked">••••</dd>
                <dt>CSRF token</dt>
                <dd className="devtools-masked">••••</dd>
                <dt>Location</dt>
                <dd>/notes/13</dd>
              </dl>
              <div className="devtools-queries">
                <span className="devtools-queries-label">QUERIES IN THIS REQUEST</span>
                <code>insert into &quot;notes&quot; (&quot;user_id&quot;, &quot;title&quot;, &quot;body&quot;, …) values (?, ?, ?, …)</code>
              </div>
            </div>
          </div>
        </figure>
      </div>
    </section>
  );
}

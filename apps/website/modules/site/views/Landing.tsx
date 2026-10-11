import { Head, Link } from '@marmeon/react';

/** `/`: a placeholder until the landing page is built — the way into the docs. */
export default function Landing() {
  return (
    <div className="page home">
      <Head title="" />
      <article className="doc">
        <h1>Marmeon</h1>
        <p className="lead">A full-stack framework for TypeScript on Node.js.</p>
        <ul>
          <li>
            <Link href="/docs/installation" prefetch>
              Get started
            </Link>
          </li>
          <li>
            <Link route="docs.home" prefetch>
              Read the docs
            </Link>
          </li>
        </ul>
      </article>
    </div>
  );
}

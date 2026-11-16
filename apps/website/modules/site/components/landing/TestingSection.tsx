import { Link } from '@marmeon/react';
import type { HighlightedSnippet } from '../../SiteSnippets.ts';
import { FAKES } from '../../fakes.ts';
import { CodeBlock } from '../CodeBlock.tsx';

/** "A test goes through the whole kernel": one HTTP test and the fakes that come with `createTestApp()`. */
export function TestingSection({ snippet }: { snippet: HighlightedSnippet }) {
  return (
    <section className="testing duo-card" aria-labelledby="testing-title">
      <p className="section-label">Testing built in</p>
      <h2 id="testing-title">
        A test goes through <span className="serif-accent">the whole kernel.</span>
      </h2>
      <p>
        Sign in, visit the page, check what it renders and with which props. The session is included, and the database is migrated and empty for each test.{' '}
        <Link href="/docs/testing-pages">Testing pages</Link>
      </p>
      <CodeBlock copy={false} html={snippet.html} caption={snippet.file} />
      <div className="fakes">
        <h3 className="group-label">A fake for each</h3>
        <ul className="fake-list">
          {FAKES.map((fake) => (
            <li key={fake}>{fake}</li>
          ))}
        </ul>
        <Link href="/docs/fakes">Fakes</Link>
      </div>
    </section>
  );
}

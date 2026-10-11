import { Link } from '@marmeon/react';
import type { HighlightedSnippet } from '../../SiteSnippets.ts';
import { CodeBlock } from '../CodeBlock.tsx';

const FAKES = ['Mail', 'Queue', 'Notifications', 'Storage', 'Events', 'Live updates', 'Schedule'];

/** "A test goes through the whole kernel": one HTTP test and the fakes that come with `createTestApp()`. */
export function TestingSection({ snippet }: { snippet: HighlightedSnippet }) {
  return (
    <section className="testing" aria-labelledby="testing-title">
      <div className="landing-inner landing-columns">
        <div className="section-intro">
          <p className="section-label">Testing built in</p>
          <h2 id="testing-title">A test goes through the whole kernel.</h2>
          <p>
            Sign in, visit the page, check what it renders and with which props. The session is included, and the database is migrated and empty for each test.{' '}
            <Link href="/docs/testing-pages">Testing pages</Link>
          </p>
          <h3 className="group-label">A fake for each</h3>
          <ul className="fake-list">
            {FAKES.map((fake) => (
              <li key={fake}>{fake}</li>
            ))}
          </ul>
          <p>
            <Link href="/docs/fakes">Fakes</Link>
          </p>
        </div>
        <CodeBlock html={snippet.html} caption={snippet.file} />
      </div>
    </section>
  );
}

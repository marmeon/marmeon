import { Link } from '@marmeon/react';
import { Terminal } from '../Terminal.tsx';

const FILES: { name: string; folder?: boolean; role: string }[] = [
  { name: 'routes.ts', role: 'routes and their names' },
  { name: 'controllers/', folder: true, role: 'one class per endpoint' },
  { name: 'views/', folder: true, role: 'React pages' },
  { name: 'migrations/', folder: true, role: "the module's tables" },
  { name: 'jobs/', folder: true, role: 'queued work' },
  { name: 'notes.test.ts', role: 'tests, next to the code' },
  { name: 'index.ts', role: 'the definition, and what other modules may import' },
];

/** "A feature lives in one folder": what a module brings, and the module's files. */
export function ModulesSection() {
  return (
    <section className="modules" aria-labelledby="modules-title">
      <div className="landing-inner landing-columns">
        <div className="section-intro">
          <p className="section-label">Modules first</p>
          <h2 id="modules-title">A feature lives in one folder.</h2>
          <p>
            A module in <code>modules/&lt;name&gt;/</code> brings its own routes, controllers, React views, migrations, jobs, listeners, config and tests.
          </p>
          <p>
            Installed framework packages join the app on their own. Add one, and it is registered. <Link href="/docs/modules#discovery">Discovery</Link>
          </p>
          <Terminal commands={['pnpm add @marmeon/redis']} />
        </div>
        <figure className="file-tree">
          <figcaption>modules/notes/</figcaption>
          <ul aria-label="Files of the notes module">
            {FILES.map(({ name, folder, role }) => (
              <li key={name}>
                <span className={folder ? 'file-tree-folder' : undefined}>{name}</span>
                <span className="file-tree-role">{role}</span>
              </li>
            ))}
          </ul>
        </figure>
      </div>
    </section>
  );
}

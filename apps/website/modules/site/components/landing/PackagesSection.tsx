import type { PageProps } from '@marmeon/http';
import { Link } from '@marmeon/react';
import type { ShowLandingController } from '../../controllers/ShowLandingController.ts';
import { PACKAGES_URL } from '../../links.ts';

/** "N packages, one version": every package of the framework with a link to its page, in three groups, from the list the server hands over. */
export function PackagesSection({ packages, packageGroups }: Pick<PageProps<ShowLandingController>, 'packages' | 'packageGroups'>) {
  return (
    <section className="packages landing-light" aria-labelledby="packages-title" id="packages">
      <div className="landing-inner">
        <div className="packages-frame">
          <p className="section-label">One release</p>
          <h2 id="packages-title">
            {packages.length} packages, <span className="serif-accent">one version.</span>
          </h2>
          <p className="packages-intro">
            Released together and wired to each other. <Link href={PACKAGES_URL}>All packages</Link>
          </p>
          {packageGroups.map(({ group, title, note }) => {
            const members = packages.filter((entry) => entry.group === group);
            return (
              <div key={group} className="package-group">
                <h3 className="package-group-title">
                  {title} <span>{members.length}</span>
                </h3>
                {note && <p className="package-group-note">{note}</p>}
                <ul className="package-grid" aria-label={title}>
                  {members.map(({ name, docs, text }) => {
                    const scope = name.startsWith('@marmeon/') ? '@marmeon/' : '';
                    return (
                      <li key={name}>
                        <Link href={`/docs/${docs}`}>
                          <code>
                            {scope && <span className="package-scope">{scope}</span>}
                            {name.slice(scope.length)}
                          </code>
                        </Link>
                        <span>{text}</span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

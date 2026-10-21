import type { PageProps } from '@marmeon/http';
import { Link } from '@marmeon/react';
import { SiteHead } from '../../site/components/SiteHead.tsx';
import { LineBanner } from '../components/LineBanner.tsx';
import type { ShowLineHomeController } from '../controllers/ShowLineHomeController.ts';

/** `/docs/<line>`: the sections of a release line — not indexed, with the start of the newest docs as canonical. */
export default function LineHome({ line, sections }: PageProps<ShowLineHomeController>) {
  return (
    <div className="docs-home">
      <SiteHead title={`Documentation (${line.name})`} description={`The documentation of Marmeon ${line.version}.`} path="/docs" noindex />
      <div className="docs-home-inner">
        <section className="docs-home-intro" aria-labelledby="line-title">
          <div className="docs-home-lead">
            <LineBanner line={line} newest="/docs" />
            <h1 id="line-title">Marmeon {line.version}</h1>
          </div>
        </section>
        <section className="docs-home-block" aria-labelledby="line-sections">
          <h2 id="line-sections" className="docs-home-heading">
            Every section
          </h2>
          <div className="docs-home-sections">
            {sections.map((section, index) => (
              <section key={section.title} aria-labelledby={`section-${index + 1}`}>
                <h3 id={`section-${index + 1}`}>{section.title}</h3>
                <ul>
                  {section.pages.map((page) => (
                    <li key={page.path}>
                      <Link href={page.path}>{page.label}</Link>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

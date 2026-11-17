import { Link } from '@marmeon/react';
import { COMPANY_URL, DISCORD_URL, DISCUSSIONS_URL, DOCS_URL, GITHUB_URL, LICENSE_URL, PACKAGES_URL, RELEASE_POLICY_URL, SECURITY_POLICY_URL } from '../links.ts';
import { Wordmark } from './Wordmark.tsx';

/** MIT licence · © BespokeCode · Made with ❤️ in Munich. */
function Legal() {
  return (
    <span className="site-footer-legal">
      <a href={LICENSE_URL} rel="noopener">
        MIT licence
      </a>{' '}
      · ©{' '}
      <a href={COMPANY_URL} rel="noopener">
        BespokeCode
      </a>{' '}
      · Made with{' '}
      <span role="img" aria-label="love">
        ❤️
      </span>{' '}
      in Munich
    </span>
  );
}

/**
 * The footer on the stage. Full (the landing and the error pages): what Marmeon is, three columns of links, the legal line.
 * `compact` (the docs): the one-row variant with the legal line and the links that matter there.
 */
export function SiteFooter({ compact = false }: { compact?: boolean }) {
  if (compact) {
    return (
      <footer className="site-footer site-footer--compact stage">
        <div className="site-footer-inner">
          <Legal />
          <nav aria-label="Footer" className="site-footer-row">
            <Link route="site.home">Marmeon home</Link>
            <a href={GITHUB_URL} rel="noopener">
              GitHub
            </a>
            <a href={DISCORD_URL} rel="noopener">
              Discord
            </a>
            <Link href={SECURITY_POLICY_URL}>Security policy</Link>
            <Link route="site.imprint">Imprint</Link>
            <Link route="site.privacy">Privacy policy</Link>
          </nav>
        </div>
      </footer>
    );
  }
  return (
    <footer className="site-footer stage">
      <div className="site-footer-inner">
        <div className="site-footer-top">
          <div className="site-footer-about">
            <Link route="site.home" className="site-footer-brand" aria-label="Marmeon, home">
              <Wordmark small />
            </Link>
            <p>
              A TypeScript framework for the whole app, server first. Questions, or something to show? Join the{' '}
              <a href={DISCORD_URL} rel="noopener">
                Discord
              </a>{' '}
              or start a{' '}
              <a href={DISCUSSIONS_URL} rel="noopener">
                discussion on GitHub
              </a>
              .
            </p>
          </div>
          <nav aria-label="Footer" className="site-footer-columns">
            <div>
              <p className="site-footer-title">Framework</p>
              <ul>
                <li>
                  <Link href={DOCS_URL}>Docs</Link>
                </li>
                <li>
                  <Link href={PACKAGES_URL}>Packages</Link>
                </li>
                <li>
                  <Link href={RELEASE_POLICY_URL}>Releases</Link>
                </li>
              </ul>
            </div>
            <div>
              <p className="site-footer-title">Community</p>
              <ul>
                <li>
                  <a href={GITHUB_URL} rel="noopener">
                    GitHub
                  </a>
                </li>
                <li>
                  <a href={DISCORD_URL} rel="noopener">
                    Discord
                  </a>
                </li>
                <li>
                  <a href={DISCUSSIONS_URL} rel="noopener">
                    Discussions
                  </a>
                </li>
              </ul>
            </div>
            <div>
              <p className="site-footer-title">Legal</p>
              <ul>
                <li>
                  <Link href={SECURITY_POLICY_URL}>Security policy</Link>
                </li>
                <li>
                  <Link route="site.imprint">Imprint</Link>
                </li>
                <li>
                  <Link route="site.privacy">Privacy policy</Link>
                </li>
              </ul>
            </div>
          </nav>
        </div>
        <div className="site-footer-bottom">
          <Legal />
        </div>
      </div>
    </footer>
  );
}

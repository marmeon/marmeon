import { Link } from '@marmeon/react';
import { COMPANY_URL, DISCORD_URL, DOCS_URL, GITHUB_URL, LICENSE_URL, RELEASE_POLICY_URL, SECURITY_POLICY_URL } from '../links.ts';
import { Wordmark } from './Wordmark.tsx';

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <div className="site-footer-about">
          <Link route="site.home" className="site-footer-brand" aria-label="Marmeon, home">
            <Wordmark small />
          </Link>
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
        </div>
        <nav aria-label="Footer" className="site-footer-nav">
          <Link href={DOCS_URL}>Docs</Link>
          <a href={GITHUB_URL} rel="noopener">
            GitHub
          </a>
          <a href={DISCORD_URL} rel="noopener">
            Discord
          </a>
          <Link href={SECURITY_POLICY_URL}>Security Policy</Link>
          <Link href={RELEASE_POLICY_URL}>Releases and Support</Link>
          <Link route="site.imprint">Imprint</Link>
          <Link route="site.privacy">Privacy Policy</Link>
        </nav>
      </div>
    </footer>
  );
}

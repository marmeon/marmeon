import { Link } from '@marmeon/react';
import { DOCS_URL, GITHUB_URL, LICENSE_URL, RELEASE_POLICY_URL, SECURITY_POLICY_URL } from '../links.ts';
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
            · © BespokeCode
          </span>
        </div>
        <nav aria-label="Footer" className="site-footer-nav">
          <Link href={DOCS_URL}>Docs</Link>
          <a href={GITHUB_URL} rel="noopener">
            GitHub
          </a>
          <Link href={SECURITY_POLICY_URL}>Security Policy</Link>
          <Link href={RELEASE_POLICY_URL}>Release Policy</Link>
          <Link route="site.imprint">Imprint</Link>
          <Link route="site.privacy">Privacy Policy</Link>
        </nav>
      </div>
    </footer>
  );
}

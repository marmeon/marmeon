import { Link } from '@marmeon/react';

const PROTECTIONS: { title: string; text: string; href: string; page: string }[] = [
  {
    title: 'Fails closed',
    text: 'In production, and on a server where nobody set NODE_ENV, protections stay on.',
    href: '/docs/security#the-environment-decides-and-fails-closed',
    page: 'Security Overview',
  },
  {
    title: 'CSRF protection',
    text: 'Every request of the web group that may change something is checked, and a request from another site is refused.',
    href: '/docs/csrf',
    page: 'CSRF Protection',
  },
  {
    title: 'Strict Content-Security-Policy',
    text: "Every new app turns on a policy with a fresh nonce for each document. The framework renders no style attributes, so styles need no 'unsafe-inline'.",
    href: '/docs/csp',
    page: 'Content Security Policy',
  },
  {
    title: 'Signed-in pages are never cached',
    text: 'Answers for a signed-in user are sent no-store and private.',
    href: '/docs/authentication#signed-in-pages-are-never-cached',
    page: 'Authentication',
  },
  {
    title: 'Page data stays out of browser storage',
    text: 'A history entry never holds the page props, and nothing a user saw is written to the browser storage.',
    href: '/docs/navigation#what-the-history-holds',
    page: 'Navigation',
  },
  {
    title: 'Devtools only in development',
    text: 'And even there, behind a host guard that refuses every unknown host.',
    href: '/docs/security#development-routes',
    page: 'Security Overview',
  },
];

/** "Secure when nobody changes a default": a dark band, one claim per line, each with the page that backs it. */
export function SecureSection() {
  return (
    <section className="secure" aria-labelledby="secure-title">
      <div className="landing-inner">
        <div className="section-intro section-intro--wide">
          <p className="section-label">Secure by default</p>
          <h2 id="secure-title">Secure when nobody changes a default.</h2>
        </div>
        <ul className="protection-list">
          {PROTECTIONS.map(({ title, text, href, page }) => (
            <li key={title}>
              <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <rect x="1" y="1" width="14" height="14" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5" />
                <path d="M4.5 8.2l2.3 2.3 4.7-5" fill="none" stroke="currentColor" strokeWidth="1.6" />
              </svg>
              <div>
                <strong>{title}</strong>
                <span>{text}</span>
                <Link href={href}>{page}</Link>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

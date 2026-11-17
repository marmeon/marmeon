import { Link } from '@marmeon/react';

const PROTECTIONS: { title: string; text: string; href: string; page: string; icon: string }[] = [
  {
    title: 'Fails closed',
    icon: 'M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z',
    text: 'In production, and on a server where nobody set NODE_ENV, protections stay on.',
    href: '/docs/security#the-environment-decides-and-fails-closed',
    page: 'Security Overview',
  },
  {
    title: 'CSRF protection',
    icon: 'M4 12h16M12 4v16M6 6l12 12',
    text: 'Every request of the web group that may change something is checked, and a request from another site is refused.',
    href: '/docs/csrf',
    page: 'CSRF Protection',
  },
  {
    title: 'Strict Content-Security-Policy',
    icon: 'M4 5h16v14H4zM4 9h16M8 13h5',
    text: "Every new app turns on a policy with a fresh nonce for each document. The framework renders no style attributes, so styles need no 'unsafe-inline'.",
    href: '/docs/csp',
    page: 'Content Security Policy',
  },
  {
    title: 'Signed-in pages are never cached',
    icon: 'M6 11V8a6 6 0 0 1 12 0v3M5 11h14v10H5z',
    text: 'Answers for a signed-in user are sent no-store and private.',
    href: '/docs/authentication#signed-in-pages-are-never-cached',
    page: 'Authentication',
  },
  {
    title: 'Page data stays out of browser storage',
    icon: 'M4 7h16M4 12h16M4 17h10M18 15l3 3m0-3-3 3',
    text: 'A history entry never holds the page props, and nothing a user saw is written to the browser storage.',
    href: '/docs/navigation#what-the-history-holds',
    page: 'Navigation',
  },
  {
    title: 'Devtools only in development',
    icon: 'M8 9l-4 3 4 3M16 9l4 3-4 3M14 5l-4 14',
    text: 'And even there, behind a host guard that refuses every unknown host.',
    href: '/docs/security#development-routes',
    page: 'Security Overview',
  },
];

/** "Secure when nobody changes a default": one claim per card, each with the page that backs it. */
export function SecureSection() {
  return (
    <section className="secure landing-light" aria-labelledby="secure-title">
      <div className="landing-inner">
        <div className="secure-frame">
          <div className="secure-head">
            <div>
              <p className="section-label">Secure by default</p>
              <h2 id="secure-title">
                Secure when nobody <span className="serif-accent">changes a default.</span>
              </h2>
            </div>
            <Link href="/docs/security" className="secure-overview">
              Security overview
            </Link>
          </div>
          <ul className="protection-list">
            {PROTECTIONS.map(({ title, text, href, page, icon }) => (
              <li key={title}>
                <span className="protection-icon" aria-hidden="true">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" focusable="false">
                    <path d={icon} />
                  </svg>
                </span>
                <h3>{title}</h3>
                <p>{text}</p>
                <Link href={href}>{page}</Link>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

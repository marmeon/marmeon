import { Link } from '@marmeon/react';

/** Above a page of a release line: which version it documents and where the newest one is. `newest` is the path of the page there, or `/docs`. */
export function LineBanner({ line, newest }: { line: { name: string; version: string }; newest: string }) {
  return (
    <p className="line-banner" role="note">
      Marmeon {line.version} — the documentation of the {line.name} line. The newest version of {newest === '/docs' ? 'the docs' : 'this page'}:{' '}
      <Link href={newest}>{newest}</Link>
    </p>
  );
}

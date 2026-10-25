import type { ErrorPageProps } from '@marmeon/http';
import { Head, Link } from '@marmeon/react';

/** The page for a 404 — `errors/<status>` comes before `errors/Error`; the other statuses keep the built-in page. */
export default function NotFound({ title }: ErrorPageProps) {
  return (
    <main data-not-found>
      <Head title={title} />
      <h1>This page does not exist</h1>
      <p>The address may have a typo, or the page has moved.</p>
      <Link href="/">Back to the start page</Link>
    </main>
  );
}

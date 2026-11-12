import type { PageProps } from '@marmeon/http';
import { Head, Link } from '@marmeon/react';
import type { ShowContactController } from '../controllers/ShowContactController.ts';

/** How to reach the support. */
export default function Contact({ email }: PageProps<ShowContactController>) {
  return (
    <main>
      <Head title="Contact" />
      <h1>Contact</h1>
      <p>Write to {email}.</p>
      <p>
        <Link route="help.page">All help pages</Link>
      </p>
    </main>
  );
}

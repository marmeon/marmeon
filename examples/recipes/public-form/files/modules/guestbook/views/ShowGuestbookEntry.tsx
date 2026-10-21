import type { PageProps } from '@marmeon/http';
import { Head, Link } from '@marmeon/react';
import { AppLayout } from '../../auth/layouts/AppLayout.tsx';
import type { ShowGuestbookEntryController } from '../controllers/ShowGuestbookEntryController.ts';

type Props = PageProps<ShowGuestbookEntryController>;

export default function ShowGuestbookEntry({ entry }: Props) {
  return (
    <main className="app-main stack stack-loose">
      <Head title={entry.name} />
      <article className="card">
        <h1>{entry.name}</h1>
        <p>{entry.message}</p>
      </article>
      <Link route="guestbook.index" className="button-secondary">
        Back to the guestbook
      </Link>
    </main>
  );
}

ShowGuestbookEntry.layout = AppLayout;

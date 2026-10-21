import type { PageProps } from '@marmeon/http';
import { Form, Head, Link, Pagination } from '@marmeon/react';
import { AppLayout } from '../../auth/layouts/AppLayout.tsx';
import type { ListGuestbookEntriesController } from '../controllers/ListGuestbookEntriesController.ts';

type Props = PageProps<ListGuestbookEntriesController>;

// Every value is rendered as text: React escapes it, so a message with markup shows the markup and never runs it.
export default function ListGuestbookEntries({ entries }: Props) {
  return (
    <main className="app-main stack stack-loose">
      <Head title="Guestbook" />
      <h1>Guestbook</h1>
      <section className="card">
        <Form route="guestbook.store" className="stack">
          {(form) => (
            <>
              <div className="field">
                <label htmlFor="name">Your name</label>
                <input id="name" maxLength={60} {...form.field('name')} />
                {form.error('name') && <small role="alert">{form.error('name')}</small>}
              </div>
              <div className="field">
                <label htmlFor="message">Your message</label>
                <textarea id="message" rows={4} maxLength={500} {...form.field('message')} />
                {form.error('message') && <small role="alert">{form.error('message')}</small>}
              </div>
              <button type="submit" className="button" disabled={form.processing}>
                Sign the guestbook
              </button>
            </>
          )}
        </Form>
      </section>
      {entries.data.length === 0 && <p className="muted">Nobody has signed yet.</p>}
      <div className="stack">
        {entries.data.map((entry) => (
          <article key={entry.id} className="card">
            <h2>
              <Link route="guestbook.show" params={{ entry: entry.id }}>
                {entry.name}
              </Link>
            </h2>
            <p>{entry.message}</p>
          </article>
        ))}
      </div>
      <Pagination meta={entries.meta} labels={{ navigation: 'Pages of entries', previous: 'Previous', next: 'Next', page: (page) => `Page ${page}` }} />
    </main>
  );
}

ListGuestbookEntries.layout = AppLayout;

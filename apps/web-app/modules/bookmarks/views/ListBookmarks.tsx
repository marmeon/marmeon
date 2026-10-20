import type { PageProps } from '@marmeon/http';
import { Head, Link, Pagination } from '@marmeon/react';
import { AppLayout } from '../../../layouts/AppLayout.tsx';
import type { ListBookmarksController } from '../controllers/ListBookmarksController.ts';

type Props = PageProps<ListBookmarksController>;

export default function ListBookmarks({ bookmarks }: Props) {
  return (
    <main className="app-main stack stack-loose">
      <Head title="Bookmarks" />
      <div className="cluster">
        <h1>Bookmarks</h1>
        <Link route="bookmarks.create" className="button">
          New bookmark
        </Link>
      </div>
      {bookmarks.data.length === 0 && <p className="muted">No bookmarks yet.</p>}
      <div className="stack">
        {bookmarks.data.map((bookmark) => (
          <article key={bookmark.id} className="card">
            <h2>{bookmark.title}</h2>
            <div className="cluster">
              <Link route="bookmarks.edit" params={{ bookmark: bookmark.id }} className="button-secondary" data-size="small">
                Edit
              </Link>
              <Link
                route="bookmarks.destroy"
                params={{ bookmark: bookmark.id }}
                className="button-secondary"
                data-size="small"
                data-destructive=""
                confirm={{ title: `Delete ${bookmark.title}?`, message: 'This cannot be undone.', confirmLabel: 'Delete', destructive: true }}
              >
                Delete
              </Link>
            </div>
          </article>
        ))}
      </div>
      <Pagination
        meta={bookmarks.meta}
        labels={{ navigation: 'Pages', previous: 'Previous', next: 'Next', page: (page) => `Page ${page}` }}
      />
    </main>
  );
}

ListBookmarks.layout = AppLayout;

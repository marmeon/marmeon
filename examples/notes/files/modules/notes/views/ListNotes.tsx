import type { PageProps } from '@marmeon/http';
import { Head, Link, Pagination, useTranslation } from '@marmeon/react';
import { AppLayout } from '../../auth/layouts/AppLayout.tsx';
import type { ListNotesController } from '../controllers/ListNotesController.ts';

type Props = PageProps<ListNotesController>;

/** A note's body as paragraphs: a blank line starts a new one. */
const paragraphs = (body: string) => body.split(/\n\s*\n/).filter((paragraph) => paragraph.trim() !== '');

export default function ListNotes({ notes }: Props) {
  const t = useTranslation('notes');
  return (
    <main className="app-main stack stack-loose">
      <Head title={t('index.title')} />
      <div className="cluster">
        <h1>{t('index.title')}</h1>
        <Link route="notes.create" className="button">
          {t('index.new')}
        </Link>
      </div>
      {notes.data.length === 0 && <p className="muted">{t('index.empty')}</p>}
      <div className="stack">
        {notes.data.map((note) => (
          <article key={note.id} className="card">
            <h2>
              {note.title}
              {note.pinned && (
                <>
                  {' '}
                  <span className="badge">{t('index.pinned')}</span>
                </>
              )}
            </h2>
            {paragraphs(note.body).map((paragraph, index) => (
              <p key={index}>{paragraph}</p>
            ))}
            <div className="cluster">
              <Link route="notes.edit" params={{ note: note.id }} className="button-secondary" data-size="small">
                {t('index.edit')}
              </Link>
              {note.pinned ? (
                <Link route="notes.unpin" params={{ note: note.id }} className="button-secondary" data-size="small">
                  {t('index.unpin')}
                </Link>
              ) : (
                <Link route="notes.pin" params={{ note: note.id }} className="button-secondary" data-size="small">
                  {t('index.pin')}
                </Link>
              )}
              <Link
                route="notes.destroy"
                params={{ note: note.id }}
                className="button-secondary"
                data-size="small"
                data-destructive=""
                confirm={{ title: t('index.delete_title', { name: note.title }), message: t('index.delete_confirm'), confirmLabel: t('index.delete'), destructive: true }}
              >
                {t('index.delete')}
              </Link>
            </div>
          </article>
        ))}
      </div>
      <Pagination
        meta={notes.meta}
        labels={{
          navigation: t('index.pagination'),
          previous: t('index.previous'),
          next: t('index.next'),
          page: (page) => t('index.page', { page }),
        }}
      />
    </main>
  );
}

ListNotes.layout = AppLayout;

import type { PageProps } from '@marmeon/http';
import { Form, Head, Link, useTranslation, type FormFieldsOf, type FormRenderState } from '@marmeon/react';
import { AppLayout } from '../../auth/layouts/AppLayout.tsx';
import type { CreateNoteController } from '../controllers/CreateNoteController.ts';
import type { EditNoteController } from '../controllers/EditNoteController.ts';

type Props = PageProps<CreateNoteController> | PageProps<EditNoteController>;

export default function NoteForm({ note }: Props) {
  const t = useTranslation('notes');
  const title = note ? t('form.edit_title') : t('form.new_title');
  // The same fields for both routes: `notes.update` takes what `notes.store` takes.
  const fields = (form: FormRenderState<FormFieldsOf<'notes.store'>>) => (
    <>
      <div className="field">
        <label htmlFor="title">{t('form.title')}</label>
        <input id="title" defaultValue={note?.title} maxLength={120} {...form.field('title')} />
        {form.error('title') && <small role="alert">{form.error('title')}</small>}
      </div>
      <div className="field">
        <label htmlFor="body">{t('form.body')}</label>
        <textarea id="body" rows={8} defaultValue={note?.body} maxLength={10_000} {...form.field('body')} />
        {form.error('body') && <small role="alert">{form.error('body')}</small>}
      </div>
      <div className="cluster">
        <button type="submit" className="button" disabled={form.processing}>
          {t('form.save')}
        </button>
        <Link route="notes.index" className="button-secondary">
          {t('form.cancel')}
        </Link>
      </div>
    </>
  );

  return (
    <main className="app-main stack stack-loose">
      <Head title={title} />
      <h1>{title}</h1>
      <section className="card">
        {note ? (
          <Form route="notes.update" params={{ note: note.id }} className="stack" guard={t('form.unsaved')}>
            {fields}
          </Form>
        ) : (
          <Form route="notes.store" className="stack" guard={t('form.unsaved')}>
            {fields}
          </Form>
        )}
      </section>
    </main>
  );
}

NoteForm.layout = AppLayout;

import type { PageProps } from '@marmeon/http';
import { Form, Head, Link, type FormFieldsOf, type FormRenderState } from '@marmeon/react';
import { AppLayout } from '../../../layouts/AppLayout.tsx';
import type { CreateBookmarkController } from '../controllers/CreateBookmarkController.ts';
import type { EditBookmarkController } from '../controllers/EditBookmarkController.ts';

type Props = PageProps<CreateBookmarkController> | PageProps<EditBookmarkController>;

export default function BookmarkForm({ bookmark }: Props) {
  const title = bookmark ? 'Edit bookmark' : 'New bookmark';
  // The same fields for both routes: `bookmarks.update` takes what `bookmarks.store` takes.
  const fields = (form: FormRenderState<FormFieldsOf<'bookmarks.store'>>) => (
    <>
      <div className="field">
        <label htmlFor="title">Title</label>
        <input id="title" defaultValue={bookmark?.title} maxLength={120} {...form.field('title')} />
        {form.error('title') && <small role="alert">{form.error('title')}</small>}
      </div>
      <div className="cluster">
        <button type="submit" className="button" disabled={form.processing}>
          Save
        </button>
        <Link route="bookmarks.index" className="button-secondary">
          Cancel
        </Link>
      </div>
    </>
  );

  return (
    <main className="app-main stack stack-loose">
      <Head title={title} />
      <h1>{title}</h1>
      <section className="card">
        {bookmark ? (
          <Form route="bookmarks.update" params={{ bookmark: bookmark.id }} className="stack" guard="You have unsaved changes. Leave anyway?">
            {fields}
          </Form>
        ) : (
          <Form route="bookmarks.store" className="stack" guard="You have unsaved changes. Leave anyway?">
            {fields}
          </Form>
        )}
      </section>
    </main>
  );
}

BookmarkForm.layout = AppLayout;

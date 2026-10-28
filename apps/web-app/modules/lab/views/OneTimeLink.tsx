import type { PageProps } from '@marmeon/http';
import { Head, useForm } from '@marmeon/react';
import type { OpenOneTimeLinkLabController } from '../controllers/OneTimeLinkLabController.ts';

/** A link that works once: opening it shows a button, and the button's POST uses the link up. */
export default function OneTimeLink({ opened, path }: PageProps<OpenOneTimeLinkLabController>) {
  const form = useForm({});
  return (
    <main>
      <Head title="A link used once" />
      <h1>A link used once</h1>
      {opened ? (
        <p>This link is used up now: a second visit gets a 404.</p>
      ) : (
        <form
          method="post"
          action={path}
          onSubmit={(event) => {
            event.preventDefault();
            void form.post(path);
          }}
        >
          <button type="submit" disabled={form.processing}>
            Use this link
          </button>
        </form>
      )}
    </main>
  );
}

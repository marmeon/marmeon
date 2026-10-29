import type { PageProps } from '@marmeon/http';
import { Head, useForm } from '@marmeon/react';
import type { ShowInvitationLabController } from '../controllers/InvitationLabController.ts';

/** The page a token route redirects to: no token in its URL, and a native POST that returns here with errors and the input. */
export default function Invitation({ invitation }: PageProps<ShowInvitationLabController>) {
  const form = useForm({ name: '' });
  return (
    <main>
      <Head title="An invitation" />
      <h1>An invitation</h1>
      <p>{invitation}</p>
      <form
        method="post"
        action="/lab/invitation"
        onSubmit={(event) => {
          event.preventDefault();
          void form.post('/lab/invitation');
        }}
      >
        <label htmlFor="name">Name</label>
        <input id="name" name="name" value={form.data.name} onChange={(event) => form.set('name', event.target.value)} />
        {form.errors.name && <small role="alert">{form.errors.name}</small>}
        <button type="submit" disabled={form.processing}>
          Accept
        </button>
      </form>
    </main>
  );
}

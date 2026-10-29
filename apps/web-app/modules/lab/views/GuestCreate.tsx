import type { PageProps } from '@marmeon/http';
import { Head, useForm } from '@marmeon/react';
import { GuestFields } from '../GuestFields.tsx';
import type { CreateGuestLabController, StoreGuestLabController } from '../controllers/GuestLabController.ts';

/** Adding a guest: the shared fields, and the invitation code only a new guest has. */
export default function GuestCreate(_props: PageProps<CreateGuestLabController>) {
  const form = useForm<StoreGuestLabController>({ name: '', email: '', invite: '' });
  return (
    <main>
      <Head title="New guest" />
      <h1>New guest</h1>
      <form
        method="post"
        action="/lab/guests"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void form.post('/lab/guests');
        }}
      >
        <GuestFields form={form} />
        <p>
          <label htmlFor="invite">Invitation code</label>
          <br />
          <input id="invite" name="invite" value={form.data.invite ?? ''} onChange={(event) => form.set('invite', event.target.value)} />
        </p>
        <button type="submit" disabled={form.processing}>
          Add
        </button>
      </form>
    </main>
  );
}

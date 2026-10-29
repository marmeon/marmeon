import type { PageProps } from '@marmeon/http';
import { Head, useForm } from '@marmeon/react';
import { GuestFields } from '../GuestFields.tsx';
import type { EditGuestLabController, UpdateGuestLabController } from '../controllers/GuestLabController.ts';

/** Changing a guest: the shared fields, and whether the guest is still coming — only an existing guest has that. */
export default function GuestEdit({ guest }: PageProps<EditGuestLabController>) {
  const form = useForm<UpdateGuestLabController>({ name: guest.name, email: guest.email, coming: guest.coming });
  return (
    <main>
      <Head title="Edit guest" />
      <h1>Edit guest</h1>
      <form
        method="post"
        action="/lab/guests"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void form.put('/lab/guests');
        }}
      >
        <input type="hidden" name="_method" value="PUT" />
        <GuestFields form={form} />
        <p>
          <label>
            <input type="checkbox" name="coming" checked={form.data.coming === true} onChange={(event) => form.set('coming', event.target.checked)} /> Coming
          </label>
        </p>
        <button type="submit" disabled={form.processing}>
          Save
        </button>
      </form>
    </main>
  );
}

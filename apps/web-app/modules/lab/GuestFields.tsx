import type { FormPart } from '@marmeon/react';
import type { StoreGuestLabController } from './controllers/GuestLabController.ts';

/**
 * The fields the guest forms share, typed by what they show: any form of a controller whose schema has `name` and `email` fits —
 * the create and the edit form here — and `form.errors` is keyed by these two.
 */
export function GuestFields({ form }: { form: FormPart<StoreGuestLabController, 'name' | 'email'> }) {
  return (
    <>
      <p>
        <label htmlFor="name">Name</label>
        <br />
        <input id="name" name="name" value={form.data.name} onChange={(event) => form.set('name', event.target.value)} aria-invalid={!!form.errors.name} />
        {form.errors.name && <small role="alert" data-error="name"> {form.errors.name}</small>}
      </p>
      <p>
        <label htmlFor="email">E-mail</label>
        <br />
        <input id="email" name="email" type="email" value={form.data.email} onChange={(event) => form.set('email', event.target.value)} aria-invalid={!!form.errors.email} />
        {form.errors.email && <small role="alert" data-error="email"> {form.errors.email}</small>}
      </p>
    </>
  );
}

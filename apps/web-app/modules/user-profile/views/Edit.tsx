import type { PageProps } from '@bespokecore/http';
import { Link, useForm } from '@bespokecore/react';
import type { EditUserProfileController } from '../controllers/EditUserProfileController.ts';
import type { UpdateUserProfileController } from '../controllers/UpdateUserProfileController.ts';

type Props = PageProps<EditUserProfileController>;

export default function Edit({ profile, old }: Props) {
  // Fields and errors are typed from UpdateUserProfileRequest's schema (its input type).
  const form = useForm<UpdateUserProfileController>({ name: old.name ?? profile.name, bio: old.bio ?? profile.bio });

  return (
    <main>
      <h1>Edit profile</h1>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void form.put(`/users/${profile.id}`);
        }}
      >
        <p>
          <label htmlFor="name">Name</label>
          <br />
          <input id="name" value={form.data.name} onChange={(e) => form.set('name', e.target.value)} aria-invalid={!!form.errors.name} />
          {form.errors.name && <small role="alert"> {form.errors.name}</small>}
        </p>
        <p>
          <label htmlFor="bio">Bio</label>
          <br />
          <textarea id="bio" rows={3} value={form.data.bio} onChange={(e) => form.set('bio', e.target.value)} aria-invalid={!!form.errors.bio} />
          {form.errors.bio && <small role="alert"> {form.errors.bio}</small>}
        </p>
        <button type="submit" disabled={form.processing || !form.isDirty}>
          {form.processing ? 'Saving…' : 'Save'}
        </button>{' '}
        <Link href={`/users/${profile.id}`}>Cancel</Link>
      </form>
    </main>
  );
}

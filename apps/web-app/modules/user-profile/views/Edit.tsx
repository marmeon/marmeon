import type { PageProps } from '@bespokecore/http';
import { Head, Link, useForm } from '@bespokecore/react';
import type { EditUserProfileController } from '../controllers/EditUserProfileController.ts';

type Props = PageProps<EditUserProfileController>;

export default function Edit({ profile, old }: Props) {
  // E40: method, URL and fields from the route name — user-profile.update → UpdateUserProfileRequest's schema (its input type).
  const form = useForm('user-profile.update', { user: profile.id }, { name: old.name ?? profile.name, bio: old.bio ?? profile.bio });

  return (
    <main>
      <Head title="Edit profile" />
      <h1>Edit profile</h1>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void form.submit();
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
        <Link route="user-profile.show" params={{ user: profile.id }}>
          Cancel
        </Link>
      </form>
    </main>
  );
}

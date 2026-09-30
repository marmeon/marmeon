import type { PageProps } from '@bespokecore/core';
import type { UserProfileController } from '../UserProfileController.ts';

// Props are inferred from the controller — change the controller, and this view type-checks against it.
type Props = PageProps<UserProfileController['show']>;

export default function Show({ profile, email, isOwnProfile }: Props) {
  return (
    <main>
      <h1>{profile.name}</h1>
      <p>{profile.bio}</p>
      {email !== null && <p>{email}</p>}
      {isOwnProfile && <a href="/settings/profile">Edit profile</a>}
    </main>
  );
}

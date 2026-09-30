import type { PageProps } from '@bespokecore/core';
import { Link } from '@bespokecore/react';
import type { UserProfileController } from '../UserProfileController.ts';

// Props are inferred from the controller — change the controller, and this view type-checks against it.
type Props = PageProps<UserProfileController['show']>;

export default function Show({ profile, email, isOwnProfile, viewer, others }: Props) {
  return (
    <main>
      <header>
        Signed in as {viewer.name}
        <form method="post" action="/logout" style={{ display: 'inline', marginLeft: 8 }}>
          <button type="submit">Sign out</button>
        </form>
      </header>

      <h1>{profile.name}</h1>
      <p>{profile.bio}</p>
      {email !== null && <p>{email}</p>}
      {isOwnProfile && <p><em>This is your profile.</em></p>}

      <nav>
        <h2>Other people</h2>
        <ul>
          {others.map((other) => (
            <li key={other.id}>
              <Link href={`/users/${other.id}`}>{other.name}</Link>
            </li>
          ))}
          {!isOwnProfile && (
            <li>
              <Link href="/users/me">Back to my profile</Link>
            </li>
          )}
        </ul>
      </nav>
    </main>
  );
}

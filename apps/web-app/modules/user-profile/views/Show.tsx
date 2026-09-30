import type { PageProps } from '@bespokecore/http';
import { Link } from '@bespokecore/react';
import type { ShowUserProfileController } from '../controllers/ShowUserProfileController.ts';

// Props are inferred from the controller — change the controller, and this view type-checks against it.
type Props = PageProps<ShowUserProfileController>;

export default function Show({ profile, email, isOwnProfile, viewer, lastLoginAt, others }: Props) {
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
      <p>
        <small>Last signed in: {lastLoginAt ? new Date(lastLoginAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'never'}</small>
      </p>
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

import type { PageProps } from '@bespokecore/http';
import { Link } from '@bespokecore/react';
import type { ShowUserProfileController } from '../controllers/ShowUserProfileController.ts';

// Props are inferred from the controller — change the controller, and this view type-checks against it.
type Props = PageProps<ShowUserProfileController>;

export default function Show({ profile, email, isOwnProfile, viewer, lastLoginAt, filter, others, status }: Props) {
  return (
    <main>
      <header>
        Signed in as {viewer.name}
        {/* A visit with the CSRF token from the XSRF-TOKEN cookie — no hidden form field needed. */}
        <Link method="post" href="/logout" style={{ marginLeft: 8 }}>
          Sign out
        </Link>
      </header>

      {status && <p role="status">{status}</p>}
      <h1>{profile.name}</h1>
      <p>{profile.bio}</p>
      {email !== null && <p>{email}</p>}
      <p>
        <small>Last signed in: {lastLoginAt ? new Date(lastLoginAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'never'}</small>
      </p>
      {isOwnProfile && (
        <p>
          <em>This is your profile.</em> <Link href={`/users/${profile.id}/edit`}>Edit profile</Link>
        </p>
      )}

      <nav>
        <h2>Other people</h2>
        <form method="get">
          <input type="search" name="q" defaultValue={filter} placeholder="Filter by name" aria-label="Filter by name" />
        </form>
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

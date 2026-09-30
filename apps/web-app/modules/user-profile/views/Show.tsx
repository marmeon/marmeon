import type { PageProps } from '@bespokecore/http';
import { Head, Link } from '@bespokecore/react';
import type { ShowUserProfileController } from '../controllers/ShowUserProfileController.ts';

const utc = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;

// Props are inferred from the controller — change the controller, and this view type-checks against it.
type Props = PageProps<ShowUserProfileController>;

export default function Show({ profile, email, isOwnProfile, lastLoginAt, filter, others, auth, flash }: Props) {
  return (
    <main>
      <Head title={profile.name}>
        <meta name="description" content={profile.bio} />
      </Head>
      <header>
        Signed in as {auth.user?.name}
        {/* A visit with the CSRF token from the XSRF-TOKEN cookie — no hidden form field needed. */}
        <Link method="post" href="/logout" style={{ marginLeft: 8 }}>
          Sign out
        </Link>
      </header>

      {flash.status && <p role="status">{flash.status}</p>}
      <h1>{profile.name}</h1>
      <p>{profile.bio}</p>
      {email !== null && <p>{email}</p>}
      <p>
        <small>Last signed in: {lastLoginAt ? utc(lastLoginAt) : 'never'}</small>
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
              <Link href={`/users/${other.id}`}>{other.name}</Link>{' '}
              <small>{other.lastLoginAt ? `last seen ${utc(other.lastLoginAt)}` : 'never signed in'}</small>
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

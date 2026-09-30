import type { PageProps } from '@bespokecore/http';
import { Head, Link } from '@bespokecore/react';
import type { ShowUserProfileController } from '../controllers/ShowUserProfileController.ts';

const utc = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
/** "3 minutes ago" — against the server's `now`, so server and browser render the same. */
function ago(iso: string, now: string): string {
  const seconds = Math.round((Date.parse(iso) - Date.parse(now)) / 1000);
  const [value, unit] =
    Math.abs(seconds) < 60 ? [seconds, 'second'] : Math.abs(seconds) < 3600 ? [seconds / 60, 'minute'] : Math.abs(seconds) < 86_400 ? [seconds / 3600, 'hour'] : [seconds / 86_400, 'day'];
  return relative.format(Math.round(value), unit as Intl.RelativeTimeFormatUnit);
}

// Props are inferred from the controller — change the controller, and this view type-checks against it.
type Props = PageProps<ShowUserProfileController>;

export default function Show({ profile, email, isOwnProfile, lastLoginAt, filter, others, now, auth, flash }: Props) {
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
        <small>Last signed in: {lastLoginAt ? <time dateTime={lastLoginAt} title={utc(lastLoginAt)}>{ago(lastLoginAt, now)}</time> : 'never'}</small>
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
              <small>{other.lastLoginAt ? `last seen ${ago(other.lastLoginAt, now)}` : 'never signed in'}</small>
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

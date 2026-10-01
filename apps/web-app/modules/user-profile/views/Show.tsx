import type { PageProps } from '@bespokecore/http';
import { Head, Link, Pagination, useForm } from '@bespokecore/react';
import type { AddProfileLinkController } from '../controllers/AddProfileLinkController.ts';
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

export default function Show({ profile, email, isOwnProfile, can, lastLoginAt, filter, others, now, auth, flash }: Props) {
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
        <small>Member since {profile.created_at.slice(0, 10)}</small>
      </p>
      <p>
        <small>Last signed in: {lastLoginAt ? <time dateTime={lastLoginAt} title={utc(lastLoginAt)}>{ago(lastLoginAt, now)}</time> : 'never'}</small>
      </p>
      {isOwnProfile && (
        <p>
          <em>This is your profile.</em> <Link href="/settings/security">Security</Link>
        </p>
      )}
      {/* Offered only when the policy allows it (the `can` prop) — the server checks again on submit. */}
      {can.update && (
        <p>
          <Link href={`/users/${profile.id}/edit`}>Edit profile</Link>
        </p>
      )}

      <section aria-label="Links">
        {profile.links.length > 0 && (
          <ul>
            {profile.links.map((link) => (
              <li key={link.id}>
                <a href={link.url} rel="nofollow noopener" target="_blank">
                  {link.label}
                </a>
                {can.update && (
                  <>
                    {' '}
                    <Link method="delete" href={`/users/${profile.id}/links/${link.id}`} aria-label={`Remove ${link.label}`}>
                      Remove
                    </Link>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        {can.update && <AddLink userId={profile.id} />}
      </section>

      <nav>
        <h2>Other people</h2>
        <form method="get">
          <input type="search" name="q" defaultValue={filter} placeholder="Filter by name" aria-label="Filter by name" />
        </form>
        <ul>
          {others.data.map((other) => (
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
        <Pagination meta={others.meta} />
      </nav>
    </main>
  );
}

function AddLink({ userId }: { userId: number }) {
  const form = useForm<AddProfileLinkController>({ label: '', url: '' });
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void form.post(`/users/${userId}/links`, { onSuccess: () => form.reset() });
      }}
    >
      <input aria-label="Label" placeholder="Label" value={form.data.label} onChange={(e) => form.set('label', e.target.value)} />{' '}
      <input aria-label="URL" placeholder="https://…" value={form.data.url} onChange={(e) => form.set('url', e.target.value)} />{' '}
      <button disabled={form.processing}>Add link</button>
      {form.errors.label && <small role="alert"> {form.errors.label}</small>}
      {form.errors.url && <small role="alert"> {form.errors.url}</small>}
    </form>
  );
}

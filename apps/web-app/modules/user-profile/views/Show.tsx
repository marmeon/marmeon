import type { PageProps } from '@bespokecore/http';
import { Deferred, Head, Link, useForm, usePoll, WhenVisible } from '@bespokecore/react';
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

/** How often the recent activity is refreshed while the page is open (ms). */
const ACTIVITY_POLL = 15_000;

// Props are inferred from the controller — change the controller, and this view type-checks against it.
type Props = PageProps<ShowUserProfileController>;

export default function Show({ profile, email, isOwnProfile, can, lastLoginAt, filter, others, activity, stats, now, auth }: Props) {
  // The activity panel keeps itself current: a background reload of just `activity`, paused while the tab is hidden.
  usePoll<ShowUserProfileController>(ACTIVITY_POLL, { only: ['activity'] });
  return (
    <main>
      <Head title={profile.name}>
        <meta name="description" content={profile.bio} />
      </Head>
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
          <em>This is your profile.</em> <Link route="auth.security">Settings</Link>
        </p>
      )}
      {isOwnProfile && auth.user && !auth.user.verified && (
        <p role="note">
          Please confirm your e-mail address — the link is in your inbox.{' '}
          <Link route="auth.verification.send">
            Send it again
          </Link>
        </p>
      )}
      {/* Offered only when the policy allows it (the `can` prop) — the server checks again on submit. */}
      {can.update && (
        <p>
          <Link route="user-profile.edit" params={{ user: profile.id }}>
            Edit profile
          </Link>
        </p>
      )}

      <section aria-labelledby="activity">
        <h2 id="activity">Recent activity</h2>
        {/* `activity` is deferred: the page renders without it, the browser loads it right after. */}
        <Deferred<ShowUserProfileController> data="activity" fallback={<p aria-busy="true">Loading activity…</p>}>
          {() => (
            <ul>
              {activity!.map((entry, index) => (
                <li key={index}>
                  {entry.kind === 'link' ? `Added the link “${entry.label}”` : entry.kind === 'signed-in' ? 'Signed in' : 'Joined'}{' '}
                  <small>
                    <time dateTime={entry.at} title={utc(entry.at)}>
                      {ago(entry.at, now)}
                    </time>
                  </small>
                </li>
              ))}
            </ul>
          )}
        </Deferred>
      </section>

      <section aria-labelledby="stats">
        <h2 id="stats">Statistics</h2>
        {/* `stats` is optional: never sent with the page — asked for (a partial reload) once this section scrolls into view. */}
        <WhenVisible<ShowUserProfileController> data="stats" buffer={100} fallback={<p aria-busy="true">Loading statistics…</p>}>
          {() => (
            <p>
              {stats!.links === 1 ? '1 link' : `${stats!.links} links`} · member {stats!.memberNumber} of {stats!.members}
            </p>
          )}
        </WhenVisible>
      </section>

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
                    <Link route="user-profile.links.destroy" params={{ user: profile.id, link: link.id }} aria-label={`Remove ${link.label}`}>
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
              {/* Fetched ahead while the pointer rests on it: the click shows the profile at once. */}
              <Link route="user-profile.show" params={{ user: other.id }} prefetch>
                {other.name}
              </Link>{' '}
              <small>{other.lastLoginAt ? `last seen ${ago(other.lastLoginAt, now)}` : 'never signed in'}</small>
            </li>
          ))}
          {!isOwnProfile && (
            <li>
              <Link route="user-profile.me">Back to my profile</Link>
            </li>
          )}
        </ul>
        {others.meta.nextCursor && (
          // The next five, appended (`others` is deepMerge()d on the server) — the URL stays the list's, so a reload
          // starts over at the top; Back and Forward keep what was loaded (the page in memory). Without JavaScript,
          // an ordinary link to the next five.
          <Link
            route="user-profile.show"
            params={{ user: profile.id }}
            query={{ ...(filter ? { q: filter } : {}), cursor: others.meta.nextCursor }}
            only={['others']}
            preserveUrl
            preserveScroll
            preserveState
          >
            Load more
          </Link>
        )}
      </nav>
    </main>
  );
}

function AddLink({ userId }: { userId: number }) {
  const form = useForm('user-profile.links.store', { user: userId }, { label: '', url: '' });
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void form.submit({ onSuccess: () => form.reset() });
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

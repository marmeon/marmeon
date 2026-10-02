import type { PageProps } from '@bespokecore/http';
import { Deferred, Head, Link, useForm, usePoll, useTranslation, WhenVisible } from '@bespokecore/react';
import type { ShowUserProfileController } from '../controllers/ShowUserProfileController.ts';


/** How often the recent activity is refreshed while the page is open (ms). */
const ACTIVITY_POLL = 15_000;

// Props are inferred from the controller — change the controller, and this view type-checks against it.
type Props = PageProps<ShowUserProfileController>;

export default function Show({ profile, email, isOwnProfile, can, lastLoginAt, activity, stats, now, auth }: Props) {
  // The activity panel keeps itself current: a background reload of just `activity`, paused while the tab is hidden.
  usePoll<ShowUserProfileController>(ACTIVITY_POLL, { only: ['activity'] });
  const t = useTranslation('user-profile');
  // "3 minutes ago", "gestern" — against the server's `now`, so server and browser render the same; the date in UTC alike.
  const ago = (iso: string) => t.format.relative(iso, now);
  const utc = (iso: string) => `${t.format.date(iso, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC`;
  return (
    <main>
      <Head title={profile.name}>
        <meta name="description" content={profile.bio} />
      </Head>
      <h1>{profile.name}</h1>
      <p>{profile.bio}</p>
      {email !== null && <p>{email}</p>}
      <p>
        <small>{t('show.member_since', { date: t.format.date(profile.created_at, { dateStyle: 'long', timeZone: 'UTC' }) })}</small>
      </p>
      <p>
        <small>
          {t('show.last_signed_in')}{' '}
          {lastLoginAt ? (
            <time dateTime={lastLoginAt} title={utc(lastLoginAt)}>
              {ago(lastLoginAt)}
            </time>
          ) : (
            t('show.never')
          )}
        </small>
      </p>
      {isOwnProfile && (
        <p>
          <em>{t('show.own')}</em> <Link route="auth.security">{t('show.settings')}</Link>
        </p>
      )}
      {isOwnProfile && auth.user && !auth.user.verified && (
        <p role="note">
          {t('show.verify')} <Link route="auth.verification.send">{t('show.verify_again')}</Link>
        </p>
      )}
      {/* Offered only when the policy allows it (the `can` prop) — the server checks again on submit. A layer (E53): the
          profile stays under it, with its activity and statistics as loaded. */}
      {can.update && (
        <p>
          <Link route="user-profile.edit" params={{ user: profile.id }} layer prefetch>
            {t('show.edit')}
          </Link>
        </p>
      )}

      <section aria-labelledby="activity">
        <h2 id="activity">{t('show.activity')}</h2>
        {/* `activity` is deferred: the page renders without it, the browser loads it right after. */}
        <Deferred<ShowUserProfileController> data="activity" fallback={<p aria-busy="true">{t('show.activity_loading')}</p>}>
          {() => (
            <ul>
              {activity!.map((entry, index) => (
                <li key={index}>
                  {t('show.activity_entry', { kind: entry.kind, label: entry.label ?? '' })}{' '}
                  <small>
                    <time dateTime={entry.at} title={utc(entry.at)}>
                      {ago(entry.at)}
                    </time>
                  </small>
                </li>
              ))}
            </ul>
          )}
        </Deferred>
      </section>

      <section aria-labelledby="stats">
        <h2 id="stats">{t('show.stats')}</h2>
        {/* `stats` is optional: never sent with the page — asked for (a partial reload) once this section scrolls into view. */}
        <WhenVisible<ShowUserProfileController> data="stats" buffer={100} fallback={<p aria-busy="true">{t('show.stats_loading')}</p>}>
          {() => (
            <p>{t('show.stats_text', { links: stats!.links, number: stats!.memberNumber, members: stats!.members })}</p>
          )}
        </WhenVisible>
      </section>

      <section aria-label={t('show.links')}>
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
                    {/* Asks first — a layer over the profile ("Remove this link?"). */}
                    <Link route="user-profile.links.remove" params={{ user: profile.id, link: link.id }} layer aria-label={t('show.remove_label', { label: link.label })}>
                      {t('show.remove')}
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
        <ul>
          <li>
            {/* The list of everyone lives on its own page now, its filters in the URL (useQueryState). */}
            <Link route="user-profile.people" prefetch>
              {t('show.people')}
            </Link>
          </li>
          {!isOwnProfile && (
            <li>
              <Link route="user-profile.me">{t('show.back')}</Link>
            </li>
          )}
        </ul>
      </nav>
    </main>
  );
}

function AddLink({ userId }: { userId: number }) {
  const t = useTranslation('user-profile');
  const form = useForm('user-profile.links.store', { user: userId }, { label: '', url: '' });
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void form.submit({ onSuccess: () => form.reset() });
      }}
    >
      <input aria-label={t('show.add_label')} placeholder={t('show.add_label')} value={form.data.label} onChange={(e) => form.set('label', e.target.value)} />{' '}
      <input aria-label={t('show.add_url')} placeholder="https://…" value={form.data.url} onChange={(e) => form.set('url', e.target.value)} />{' '}
      <button disabled={form.processing}>{t('show.add')}</button>
      {form.errors.label && <small role="alert"> {form.errors.label}</small>}
      {form.errors.url && <small role="alert"> {form.errors.url}</small>}
    </form>
  );
}

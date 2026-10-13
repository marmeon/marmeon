import type { PageProps } from '@marmeon/http';
import {
  Deferred,
  Head,
  Link,
  useAction,
  usePendingSubmissions,
  usePoll,
  useRouter,
  useTranslation,
  useRemember,
  WhenVisible,
  type Placeholder,
  type RevalidateOnBack,
} from '@marmeon/react';
import { ViewTransition } from 'react';
import { ActionFailure } from '../../../layouts/ActionFailure.tsx';
import type { ShowUserProfileController } from '../controllers/ShowUserProfileController.ts';


/** How often the recent activity is refreshed while the page is open (ms). */
const ACTIVITY_POLL = 15_000;

// Props are inferred from the controller — change the controller, and this view type-checks against it.
type Props = PageProps<ShowUserProfileController>;

export default function Show({ profile, email, isOwnProfile, abilities, lastLoginAt, activity, stats, now, auth }: Props) {
  // The activity panel keeps itself current: a background reload of just `activity`, paused while the tab is hidden.
  usePoll<ShowUserProfileController>(ACTIVITY_POLL, { only: ['activity'] });
  const t = useTranslation('user-profile');
  // "3 minutes ago", "gestern" — against the server's `now`, so server and browser render the same; the date in UTC alike.
  const ago = (iso: string) => t.format.relative(iso, now);
  const utc = (iso: string) => `${t.format.date(iso, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC`;
  const router = useRouter<ShowUserProfileController>();
  // Removing a link: an action — no page change. The link goes at once (a patch over the props, typed against this
  // page); a failure brings it back. Once it succeeded, the profile reloads and the patch goes with the server's answer.
  const remove = useAction('user-profile.links.destroy');
  // Links being added, from any form: ghost rows until the real ones are there (nothing to roll back).
  const adding = usePendingSubmissions('user-profile.links.store');
  const removeLink = (id: string, label: string) =>
    void remove.submit({
      params: { user: profile.public_id, link: id },
      // Asked first — a no sends nothing, and nothing disappears.
      confirm: { message: t('show.remove_confirm', { label }), confirmLabel: t('show.remove'), destructive: true },
      optimistic: router.optimistic((props) => ({ profile: { ...props.profile, links: props.profile.links.filter((link) => link.id !== id) } })),
      // Its "Link removed." comes with the action's answer — a toast, once.
      reload: router.reloading({ only: ['profile'] }),
    });
  return (
    <main>
      <Head title={profile.name}>
        <meta name="description" content={profile.bio} />
      </Head>
      {/* The avatar the list showed small: it moves here and grows — and back to the list with Back. */}
      {profile.avatar && (
        <ViewTransition name={`avatar-${profile.public_id}`} share="avatar">
          <img src={profile.avatar} alt={t('show.avatar', { name: profile.name })} width={96} height={96} className="avatar" />
        </ViewTransition>
      )}
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
      {isOwnProfile && auth?.user && !auth.user.verified && (
        // A <div>, not a <p>: the link sends (a POST), so it renders a form — which a <p> cannot hold.
        <div role="note" className="paragraph">
          {t('show.verify')} <Link route="auth.verification.send">{t('show.verify_again')}</Link>
        </div>
      )}
      {/* Offered only when the policy allows it (`abilities`) — plain booleans, the server checks again on submit. A
          layer: the profile stays under it, with its activity and statistics as loaded. */}
      {abilities.update && (
        <p>
          <Link route="user-profile.edit" params={{ user: profile.public_id }} layer prefetch>
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
        {(profile.links.length > 0 || adding.length > 0) && (
          <ul>
            {profile.links.map((link) => (
              <li key={link.id}>
                <a href={link.url} rel="nofollow noopener" target="_blank">
                  {link.label}
                </a>
                {/* Per link: the controller projected `can.delete` onto every link. */}
                {link.can.delete && (
                  <>
                    {' '}
                    <button type="button" onClick={() => removeLink(link.id, link.label)} aria-label={t('show.remove_label', { label: link.label })}>
                      {t('show.remove')}
                    </button>
                  </>
                )}
              </li>
            ))}
            {adding.map((call) => (
              <li key={`adding-${call.id}`} aria-busy="true" className="muted" data-pending-link="">
                {call.input.label} <small>{t('show.adding')}</small>
              </li>
            ))}
          </ul>
        )}
        <ActionFailure exception={remove.exception} />
        {abilities.update && <AddLink userId={profile.public_id} />}
      </section>

      <nav>
        <ul>
          <li>
            {/* The list of everyone lives on its own page, its filters in the URL (useQueryState). */}
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

// What Back/Forward reloads when it shows the profile from memory: the activity — the rest shows as it was.
Show.revalidateOnBack = ['activity'] as const satisfies RevalidateOnBack<ShowUserProfileController>;

/**
 * The profile before its answer (an instant visit from `<Link instant={{ name }}>`): the name the link knew at once, the
 * rest as a skeleton — typed by the controller's `instant`, never the page's props (they are on their way).
 */
function ShowPlaceholder({ name }: { name: string }) {
  const t = useTranslation('user-profile');
  return (
    <main aria-busy="true" data-placeholder="">
      <Head title={name} />
      <h1>{name}</h1>
      <p className="muted">{t('show.loading')}</p>
    </main>
  );
}
Show.placeholder = ShowPlaceholder satisfies Placeholder<ShowUserProfileController>;

/**
 * Adding a link — an action: the input moves into the list as a ghost row while it is sent (`usePendingSubmissions`);
 * invalid input comes back into the fields, with the errors by field.
 */
function AddLink({ userId }: { userId: string }) {
  const t = useTranslation('user-profile');
  const router = useRouter<ShowUserProfileController>();
  const add = useAction('user-profile.links.store', { user: userId });
  // Remembered: a link half typed is still there after Back/Forward — in memory only, gone with a reload.
  const [label, setLabel] = useRemember('add-link.label', '');
  const [url, setUrl] = useRemember('add-link.url', '');
  return (
    <form
      noValidate
      onSubmit={async (event) => {
        event.preventDefault();
        const data = { label, url };
        setLabel('');
        setUrl('');
        const result = await add.submit({ data, reload: router.reloading({ only: ['profile'] }) });
        // Not added: what was typed comes back (unless something new was typed meanwhile).
        if (!result.ok) {
          setLabel((current) => current || data.label);
          setUrl((current) => current || data.url);
        }
      }}
    >
      <input aria-label={t('show.add_label')} placeholder={t('show.add_label')} value={label} onChange={(e) => (setLabel(e.target.value), add.clearErrors('label'))} aria-invalid={!!add.errors.label} />{' '}
      <input aria-label={t('show.add_url')} placeholder="https://…" value={url} onChange={(e) => (setUrl(e.target.value), add.clearErrors('url'))} aria-invalid={!!add.errors.url} />{' '}
      <button>{t('show.add')}</button>
      {add.errors.label && <small role="alert"> {add.errors.label}</small>}
      {add.errors.url && <small role="alert"> {add.errors.url}</small>}
      <ActionFailure exception={add.exception} />
    </form>
  );
}

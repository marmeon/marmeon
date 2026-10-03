import type { PageProps } from '@bespokecore/http';
import { Head, Island, Link, useQueryState, useTranslation, type Placeholder } from '@bespokecore/react';
import type { ListPeopleController } from '../controllers/ListPeopleController.ts';

type Props = PageProps<ListPeopleController>;

/** The sort options, in the order the page offers them. */
const SORTS = [
  ['name', 'people.sort_name'],
  ['-name', 'people.sort_name_desc'],
  ['joined', 'people.sort_joined'],
  ['-joined', 'people.sort_joined_desc'],
] as const;

export default function People({ people, now }: Props) {
  const t = useTranslation('user-profile');
  // The URL's query, as the server parsed it (ListPeopleRequest) — typed: `query.sort` is one of the four sorts.
  // Typing filters as you go: one partial reload of `people` per pause, replacing the history entry (no entry per key).
  const [query, setQuery] = useQueryState('user-profile.people', { only: ['people'], debounce: 300, history: 'replace' });
  const ago = (iso: string) => t.format.relative(iso, now);

  return (
    <main>
      <Head title={t('people.title')} />
      <h1>{t('people.title')}</h1>
      {/* Without JavaScript an ordinary GET form — the same URL the state writes. */}
      <form method="get" role="search" onSubmit={(event) => event.preventDefault()}>
        <input
          type="search"
          name="q"
          value={query.q}
          onChange={(event) => setQuery({ q: event.target.value })}
          placeholder={t('people.search')}
          aria-label={t('people.search')}
        />
        <input type="hidden" name="sort" value={query.sort} />
      </form>
      <p aria-label={t('people.sort')}>
        {SORTS.map(([sort, label], index) => (
          <span key={sort}>
            {index > 0 && ' · '}
            {/* A link per sort (a history entry each: Back undoes a sort). Defaults are left out of the URL, and the
                list is replaced (`reset`) — merged, it would keep the old order. */}
            <Link
              route="user-profile.people"
              query={{ ...query, sort }}
              only={['people']}
              reset={['people']}
              preserveState
              preserveScroll
              aria-current={query.sort === sort ? 'true' : undefined}
            >
              {t(label)}
            </Link>
          </span>
        ))}
      </p>
      {people.data.length === 0 ? (
        <p>{t('people.none')}</p>
      ) : (
        <ul>
          {people.data.map((person) => (
            <li key={person.id}>
              {/* The avatar (W6.9), from the public disk — decorative next to the name, so no alt text of its own. */}
              {person.avatar && <img src={person.avatar} alt="" width={24} height={24} loading="lazy" style={{ objectFit: 'cover', borderRadius: '50%', verticalAlign: 'middle' }} />}{' '}
              {/* Fetched ahead while the pointer rests on it: the click shows the profile at once. If it is not here yet, an instant
                  visit (E64) shows the profile's placeholder with the name the list knows — then the profile. */}
              <Link route="user-profile.show" params={{ user: person.id }} prefetch instant={{ name: person.name }}>
                {person.name}
              </Link>
              {person.isMe && ` ${t('people.you')}`}{' '}
              <small>{person.lastLoginAt ? t('people.last_seen', { when: ago(person.lastLoginAt) }) : t('people.never_signed_in')}</small>
            </li>
          ))}
        </ul>
      )}
      {people.meta.nextCursor && (
        // The next ten, appended (`people` is deepMerge()d on the server) — the URL stays the list's, so a reload starts
        // over at the top; Back and Forward keep what was loaded (the page in memory). Without JavaScript, a plain link.
        <Link
          route="user-profile.people"
          query={{ ...query, cursor: people.meta.nextCursor }}
          only={['people']}
          preserveUrl
          preserveScroll
          preserveState
        >
          {t('people.more')}
        </Link>
      )}
      <aside aria-labelledby="recent-sign-ins">
        <h2 id="recent-sign-ins">{t('people.recent')}</h2>
        {/* The dashboard's island, reused (E48): the same route, its own query. Typing and sorting above reload the page's
            `people` only — the island stays as it is (no request). */}
        <Island route="dashboard.sign-ins" query={{ limit: 3, range: 'all' }} fallback={<p aria-busy="true">…</p>} />
      </aside>
      <p>
        <Link route="user-profile.me">{t('people.profile')}</Link>
      </p>
    </main>
  );
}

/** The list before its answer (E64, an instant visit from the main navigation). */
function PeoplePlaceholder() {
  const t = useTranslation('user-profile');
  return (
    <main aria-busy="true" data-placeholder="">
      <Head title={t('people.title')} />
      <h1>{t('people.title')}</h1>
      <p style={{ opacity: 0.5 }}>{t('people.loading')}</p>
    </main>
  );
}
People.placeholder = PeoplePlaceholder satisfies Placeholder<ListPeopleController>;

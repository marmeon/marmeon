import type { PageProps } from '@marmeon/http';
import { Head, Link, useQueryState, useTranslation } from '@marmeon/react';
import type { SearchProfileLinksController } from '../controllers/SearchProfileLinksController.ts';

type Props = PageProps<SearchProfileLinksController>;

export default function Links({ owner, links }: Props) {
  const t = useTranslation('user-profile');
  // The route has a path parameter (`/users/:user/links`): the hook follows the page's own URL, so the search stays on this profile.
  const [query, setQuery] = useQueryState('user-profile.links.index', { only: ['links'], debounceMs: 300, history: 'replace' });

  return (
    <main>
      <Head title={t('links_page.title', { name: owner.name })} />
      <h1>{t('links_page.title', { name: owner.name })}</h1>
      {/* Without JavaScript an ordinary GET form — the same URL the state writes. */}
      <form method="get" role="search" onSubmit={(event) => event.preventDefault()}>
        <input
          type="search"
          name="q"
          value={query.q}
          onChange={(event) => setQuery({ q: event.target.value })}
          placeholder={t('links_page.search')}
          aria-label={t('links_page.search')}
        />
      </form>
      {links.length === 0 ? (
        <p>{t('links_page.none')}</p>
      ) : (
        <ul>
          {links.map((link) => (
            <li key={link.id}>
              <a href={link.url} rel="nofollow noopener" target="_blank">
                {link.label}
              </a>
            </li>
          ))}
        </ul>
      )}
      <p>
        <Link route="user-profile.show" params={{ user: owner.public_id }}>
          {t('links_page.back')}
        </Link>
      </p>
    </main>
  );
}

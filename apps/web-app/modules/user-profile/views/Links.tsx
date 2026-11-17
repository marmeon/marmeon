import type { PageProps } from '@marmeon/http';
import { Head, Link, useForm, useQueryState, useTranslation } from '@marmeon/react';
import { useState } from 'react';

type EditedLink = { id: string; label: string; version: string };
import type { SearchProfileLinksController } from '../controllers/SearchProfileLinksController.ts';

type Props = PageProps<SearchProfileLinksController>;

export default function Links({ owner, abilities, links }: Props) {
  const t = useTranslation('user-profile');
  // The links being renamed, as they were when each editor opened: the editors live here, outside the filtered list, so a search the
  // typed text no longer matches — or a rename out of it — does not close an editor with its draft and its conflict.
  const [editing, setEditing] = useState<Record<string, EditedLink>>({});
  const close = (id: string) => setEditing(({ [id]: _closed, ...rest }) => rest);
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
              </a>{' '}
              {abilities.update && !editing[link.id] && (
                <button type="button" onClick={() => setEditing((current) => ({ ...current, [link.id]: link }))}>
                  {t('links_page.rename')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {abilities.update && Object.keys(editing).length > 0 && (
        <ul aria-label={t('links_page.renaming')}>
          {Object.values(editing).map((link) => (
            <li key={link.id}>
              <RenameForm userId={owner.public_id} link={link} onDone={() => close(link.id)} />
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

/**
 * Renaming a link with a form. The version the form sends is the one the page had when the editor opened (`link`) — the page reloads
 * under the form when a save is refused, and that newer version must not replace it. A refused save (the link changed meanwhile) comes
 * back as `form.conflict`: the link as it is now, beside what was typed. Saved or cancelled, the editor closes; “keep mine” sends the
 * typed label again with the version of the link as it is now.
 */
function RenameForm({ userId, link, onDone }: { userId: string; link: EditedLink; onDone: () => void }) {
  const t = useTranslation('user-profile');
  // The initial data is read once: `seen` stays what it was when the editor opened.
  const form = useForm('user-profile.links.update', { label: link.label, seen: link.version }, { params: { user: userId, link: link.id } });
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void form.submit({ onSuccess: onDone });
      }}
    >
      <input aria-label={t('links_page.rename_label', { label: link.label })} value={form.data.label} onChange={(e) => (form.set('label', e.target.value), form.clearErrors('label'))} aria-invalid={!!form.errors.label} />{' '}
      <button>{t('links_page.rename_save')}</button>
      {form.errors.label && <small role="alert"> {form.errors.label}</small>}
      {form.conflict && (
        <small role="alert">
          {' '}
          {form.conflict.current ? t('links_page.rename_theirs', { label: form.conflict.current.label }) : t('links_page.rename_gone')}{' '}
          {/* Resolved by the user: keep the typed label on top of the link as it is now (its version), or give up. */}
          {form.conflict.current && (
            <button
              type="button"
              onClick={() => {
                form.set('seen', form.conflict!.current!.savedAt);
                void form.submit({ onSuccess: onDone });
              }}
            >
              {t('links_page.rename_keep')}
            </button>
          )}{' '}
          <button type="button" onClick={onDone}>
            {t('links_page.rename_cancel')}
          </button>
        </small>
      )}
    </form>
  );
}

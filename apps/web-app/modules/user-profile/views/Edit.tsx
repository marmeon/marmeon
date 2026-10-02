import type { PageProps } from '@bespokecore/http';
import { Head, Link, useForm, useLayer, useTranslation } from '@bespokecore/react';
import { useId } from 'react';
import type { EditUserProfileController } from '../controllers/EditUserProfileController.ts';

type Props = PageProps<EditUserProfileController>;

/**
 * A layer (E53) — the same view whether it opens over the profile, over the people list, or by a deep link over its base.
 * The form submits as the layer: a validation error comes back into it, saving closes it (`closeLayer()` on the server).
 */
export default function Edit({ profile, old }: Props) {
  const t = useTranslation('user-profile');
  const layer = useLayer<EditUserProfileController>();
  // Ids of its own: a layer shares the document with the page beneath (and maybe another layer).
  const id = useId();
  // E40: method, URL and fields from the route name — user-profile.update → UpdateUserProfileRequest's schema (its input type).
  const form = useForm('user-profile.update', { user: profile.id }, { name: old.name ?? profile.name, bio: old.bio ?? profile.bio });

  // Under the page's own heading in a layer; the page's heading when the view is a page.
  const Heading = layer.isLayer ? 'h2' : 'h1';
  return (
    <section>
      <Head title={t('edit.title')} />
      <Heading>{t('edit.title')}</Heading>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void form.submit();
        }}
      >
        <p>
          <label htmlFor={`${id}-name`}>{t('edit.name')}</label>
          <br />
          <input id={`${id}-name`} autoFocus={layer.isLayer} value={form.data.name} onChange={(e) => form.set('name', e.target.value)} aria-invalid={!!form.errors.name} aria-describedby={form.errors.name ? `${id}-name-error` : undefined} />
          {form.errors.name && (
            <small id={`${id}-name-error`} role="alert">
              {' '}
              {form.errors.name}
            </small>
          )}
        </p>
        <p>
          <label htmlFor={`${id}-bio`}>{t('edit.bio')}</label>
          <br />
          <textarea id={`${id}-bio`} rows={3} value={form.data.bio} onChange={(e) => form.set('bio', e.target.value)} aria-invalid={!!form.errors.bio} aria-describedby={form.errors.bio ? `${id}-bio-error` : undefined} />
          {form.errors.bio && (
            <small id={`${id}-bio-error`} role="alert">
              {' '}
              {form.errors.bio}
            </small>
          )}
        </p>
        <button type="submit" disabled={form.processing || !form.isDirty}>
          {form.processing ? t('edit.saving') : t('edit.save')}
        </button>{' '}
        {/* In a layer, cancel closes it (Back); as a page, it goes to the profile. */}
        {layer.isLayer ? (
          <button type="button" onClick={() => void layer.close()}>
            {t('edit.cancel')}
          </button>
        ) : (
          <Link route="user-profile.show" params={{ user: profile.id }}>
            {t('edit.cancel')}
          </Link>
        )}
      </form>

      {profile.links.length > 0 && (
        <>
          <h3>{t('show.links')}</h3>
          <ul>
            {profile.links.map((link) => (
              <li key={link.id}>
                {link.label}{' '}
                {/* A second layer over this one (depth 2): "Remove this link?" */}
                <Link route="user-profile.links.remove" params={{ user: profile.id, link: link.id }} layer aria-label={t('show.remove_label', { label: link.label })}>
                  {t('show.remove')}
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

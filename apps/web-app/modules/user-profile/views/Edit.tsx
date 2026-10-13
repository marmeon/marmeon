import type { PageProps } from '@marmeon/http';
import { FileInput, Head, Link, useForm, useLayer, useLiveUpdates, useTranslation } from '@marmeon/react';
import { useId } from 'react';
import type { EditUserProfileController } from '../controllers/EditUserProfileController.ts';

type Props = PageProps<EditUserProfileController>;

/**
 * A layer — the same view whether it opens over the profile, over the people list, or by a deep link over its base.
 * The form submits as the layer: a validation error comes back into it, saving closes it (`closeLayer()` on the server).
 */
export default function Edit({ profile, old }: Props) {
  const t = useTranslation('user-profile');
  const app = useTranslation('app');
  const layer = useLayer<EditUserProfileController>();
  // Ids of its own: a layer shares the document with the page beneath (and maybe another layer).
  const id = useId();
  // Method, URL and fields from the route name — user-profile.update → UpdateUserProfileRequest's schema (its input type).
  // `guard`: with changes not saved, closing the layer, Back, a link elsewhere or closing the tab asks first.
  // `validate`: a field is checked against the server's schema when you leave it — "too short" before you save.
  // `remember`: typed, closed by Back, opened again by Forward — the input (and its errors) is still there, still dirty.
  // In memory only, with the layer's history entry: a reload, signing out or a new build start over.
  const form = useForm('user-profile.update', { user: profile.public_id }, { name: old.name ?? profile.name, bio: old.bio ?? profile.bio }, { guard: app('unsaved'), validate: true, remember: true });

  // The picture: a file input that uploads at once — to a target this route hands out for `avatar` (its policy decides),
  // with progress and cancel; the form sends only the token. On the server the file is checked again by its size and its
  // bytes (PNG, JPEG, WebP — an SVG or a renamed HTML file is refused) and moved to the public disk under a random name.
  const avatarForm = useForm('user-profile.avatar.update', { user: profile.public_id }, { avatar: null });
  const avatar = avatarForm.data.avatar;
  // Live: the profile beneath follows `users.<public_id>` — while this form has unsaved changes (its guard), a change from
  // another tab reloads nothing; it waits here until it is applied.
  const updates = useLiveUpdates();

  // Under the page's own heading in a layer; the page's heading when the view is a page.
  const Heading = layer.isLayer ? 'h2' : 'h1';
  return (
    <section>
      <Head title={t('edit.title')} />
      <Heading>{t('edit.title')}</Heading>
      {updates.pending && (
        <p role="status">
          {t('edit.updates')}{' '}
          <button type="button" onClick={updates.apply}>
            {t('edit.updates_apply')}
          </button>
        </p>
      )}
      <form
        noValidate
        aria-labelledby={`${id}-avatar-label`}
        onSubmit={(event) => {
          event.preventDefault();
          void avatarForm.submit();
        }}
      >
        <p>
          <span id={`${id}-avatar-label`}>{t('edit.avatar')}</span>
          <br />
          {(avatar?.preview ?? profile.avatar) && <img src={avatar?.preview ?? profile.avatar ?? undefined} alt="" width={96} height={96} className="avatar" />}
          <br />
          <label htmlFor={`${id}-avatar`}>{t('edit.avatar_choose')}</label>
          <br />
          <FileInput
            id={`${id}-avatar`}
            field={avatarForm.field('avatar')}
            accept="image/png,image/jpeg,image/webp"
            aria-invalid={!!(avatarForm.errors.avatar ?? avatar?.error)}
            aria-describedby={`${id}-avatar-status`}
          />
        </p>
        <p id={`${id}-avatar-status`} aria-live="polite">
          {avatar?.uploading && (
            <>
              <progress value={avatar.progress} max={1} /> <small>{t('edit.avatar_uploading', { percent: Math.round(avatar.progress * 100) })}</small>{' '}
              <button type="button" onClick={() => avatar.cancel()}>
                {t('edit.avatar_cancel')}
              </button>
            </>
          )}
          {avatar?.status === 'uploaded' && <small>{t('edit.avatar_ready')}</small>}
          {(avatarForm.errors.avatar ?? avatar?.error) && <small role="alert">{avatarForm.errors.avatar ?? avatar?.error}</small>}
        </p>
        <button type="submit" disabled={avatar?.status !== 'uploaded' || avatarForm.processing} data-pending={avatarForm.processing || undefined}>
          {avatarForm.processing ? t('edit.saving') : t('edit.avatar_save')}
        </button>
      </form>

      <form
        noValidate
        data-dirty={form.isDirty() || undefined}
        onSubmit={(event) => {
          event.preventDefault();
          void form.submit();
        }}
      >
        <p>
          <label htmlFor={`${id}-name`}>{t('edit.name')}</label>
          <br />
          <input id={`${id}-name`} autoFocus={layer.isLayer} data-dirty={form.isDirty('name') || undefined} value={form.data.name} onChange={(e) => form.set('name', e.target.value)} onBlur={() => form.validate('name')} aria-busy={form.validating('name') || undefined} aria-invalid={!!form.errors.name} aria-describedby={form.errors.name ? `${id}-name-error` : undefined} />
          {form.validating('name') && <small> {t('edit.checking')}</small>}
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
          <textarea id={`${id}-bio`} rows={3} data-dirty={form.isDirty('bio') || undefined} value={form.data.bio} onChange={(e) => form.set('bio', e.target.value)} onBlur={() => form.validate('bio')} aria-busy={form.validating('bio') || undefined} aria-invalid={!!form.errors.bio} aria-describedby={form.errors.bio ? `${id}-bio-error` : undefined} />
          {form.errors.bio && (
            <small id={`${id}-bio-error`} role="alert">
              {' '}
              {form.errors.bio}
            </small>
          )}
        </p>
        <button type="submit" disabled={form.processing || !form.isDirty()} data-pending={form.processing || undefined}>
          {form.processing ? t('edit.saving') : t('edit.save')}
        </button>{' '}
        {/* In a layer, cancel closes it (Back); as a page, it goes to the profile. */}
        {layer.isLayer ? (
          <button type="button" onClick={() => void layer.close()}>
            {t('edit.cancel')}
          </button>
        ) : (
          <Link route="user-profile.show" params={{ user: profile.public_id }}>
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
                {/* A second layer over this one (depth 2): "Remove this link?" — offered when the policy allows it. */}
                {link.can.delete && (
                  <Link route="user-profile.links.remove" params={{ user: profile.public_id, link: link.id }} layer aria-label={t('show.remove_label', { label: link.label })}>
                    {t('show.remove')}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

import type { PageProps } from '@bespokecore/http';
import { Head, useForm, useLayer, useTranslation } from '@bespokecore/react';
import { useId } from 'react';
import type { ShowCreateAccessTokenController } from '../controllers/CreateAccessTokenController.ts';

type Props = PageProps<ShowCreateAccessTokenController>;

/** A new token's form — a layer over the list. Validation errors come back into it; the answer replaces it (the plain text). */
export default function CreateAccessToken({ abilities }: Props) {
  const t = useTranslation('auth');
  const layer = useLayer<ShowCreateAccessTokenController>();
  const id = useId();
  const form = useForm('auth.tokens.store', { name: '', abilities: [] });
  const selected = [form.data.abilities ?? []].flat();

  return (
    <section>
      <Head title={t('tokens.create')} />
      <h2>{t('tokens.create')}</h2>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void form.submit();
        }}
      >
        <p>
          <label htmlFor={`${id}-name`}>{t('tokens.name')}</label>
          <br />
          <input
            id={`${id}-name`}
            autoFocus={layer.isLayer}
            value={form.data.name}
            onChange={(e) => form.set('name', e.target.value)}
            aria-invalid={!!form.errors.name}
            aria-describedby={form.errors.name ? `${id}-name-error` : undefined}
            placeholder={t('tokens.name_placeholder')}
          />
          {form.errors.name && (
            <small id={`${id}-name-error`} role="alert">
              {' '}
              {form.errors.name}
            </small>
          )}
        </p>
        <fieldset>
          <legend>{t('tokens.may')}</legend>
          {Object.entries(abilities).map(([ability, description]) => (
            <label key={ability} style={{ display: 'block' }}>
              <input
                type="checkbox"
                checked={selected.includes(ability as never)}
                onChange={(e) => form.set('abilities', (e.target.checked ? [...selected, ability] : selected.filter((item) => item !== ability)) as never)}
              />{' '}
              <code>{ability}</code> — {description}
            </label>
          ))}
          {form.errors.abilities && <small role="alert">{form.errors.abilities}</small>}
        </fieldset>
        <p>
          <button type="submit" disabled={form.processing}>
            {t('tokens.submit')}
          </button>{' '}
          {layer.isLayer && (
            <button type="button" onClick={() => void layer.close()}>
              {t('tokens.cancel')}
            </button>
          )}
        </p>
      </form>
    </section>
  );
}

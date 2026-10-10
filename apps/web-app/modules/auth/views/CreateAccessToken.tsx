import type { PageProps } from '@marmeon/http';
import { Form, Head, useLayer, useTranslation } from '@marmeon/react';
import { useId } from 'react';
import type { ShowCreateAccessTokenController } from '../controllers/CreateAccessTokenController.ts';

type Props = PageProps<ShowCreateAccessTokenController>;

/**
 * A new token's form — a layer over the list. Validation errors come back into it; the answer replaces it (the plain text).
 * An uncontrolled `<Form>`: the fields are plain named inputs (`form.field('abilities[]')` checks the name against the
 * route's schema), sent as the server parses them; without JavaScript a real form with `_token`.
 */
export default function CreateAccessToken({ abilities }: Props) {
  const t = useTranslation('auth');
  const layer = useLayer<ShowCreateAccessTokenController>();
  const id = useId();

  return (
    <section>
      <Head title={t('tokens.create')} />
      <h2>{t('tokens.create')}</h2>
      <Form route="auth.tokens.store" noValidate>
        {(form) => (
          <>
            <p>
              <label htmlFor={`${id}-name`}>{t('tokens.name')}</label>
              <br />
              <input
                id={`${id}-name`}
                {...form.field('name')}
                autoFocus={layer.isLayer}
                aria-describedby={form.error('name') ? `${id}-name-error` : undefined}
                placeholder={t('tokens.name_placeholder')}
              />
              {form.error('name') && (
                <small id={`${id}-name-error`} role="alert">
                  {' '}
                  {form.error('name')}
                </small>
              )}
            </p>
            <fieldset>
              <legend>{t('tokens.may')}</legend>
              {Object.entries(abilities).map(([ability, description]) => (
                <label key={ability} className="block">
                  <input type="checkbox" {...form.field('abilities[]')} value={ability} /> <code>{ability}</code> — {description}
                </label>
              ))}
              {form.error('abilities[]') && <small role="alert">{form.error('abilities[]')}</small>}
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
          </>
        )}
      </Form>
    </section>
  );
}

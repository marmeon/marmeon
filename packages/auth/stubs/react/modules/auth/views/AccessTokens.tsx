import type { PageProps } from '@marmeon/http';
import { Head, Link, useForm, useTranslation } from '@marmeon/react';
import type { ShowAccessTokensController } from '../controllers/ShowAccessTokensController.ts';
import { AppLayout } from '../layouts/AppLayout.tsx';
import { SettingsLayout } from '../layouts/SettingsLayout.tsx';

type Props = PageProps<ShowAccessTokensController>;

export default function AccessTokens({ tokens, abilities, plainText }: Props) {
  const t = useTranslation('auth');
  // In UTC: the server and the browser render the same text (no time zone of either side).
  const at = (iso: string) => t.format.date(iso, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
  const form = useForm('auth.tokens.store', { name: '', abilities: [] });
  const selected = [form.data.abilities ?? []].flat();

  return (
    <main className="stack">
      <Head title={t('tokens.title')} />
      <h1>{t('tokens.title')}</h1>
      {plainText && (
        <section aria-label={t('tokens.new')} role="alert" className="card">
          <p>
            <strong>{t('tokens.copy')}</strong>
          </p>
          <pre className="secret">
            <code>{plainText}</code>
          </pre>
          <p>
            {t('tokens.usage')} <code>curl -H "Authorization: Bearer {plainText.slice(0, 8)}…" /api/user</code>
          </p>
        </section>
      )}

      <section aria-labelledby="tokens-heading" className="card">
        <h2 id="tokens-heading">{t('tokens.yours')}</h2>
        {tokens.length === 0 ? (
          <p className="muted">{t('tokens.none')}</p>
        ) : (
          <div className="auth-table" role="region" aria-labelledby="tokens-heading" tabIndex={0}>
            <table aria-labelledby="tokens-heading">
              <thead>
                <tr>
                  <th scope="col">{t('tokens.name')}</th>
                  <th scope="col">{t('tokens.may')}</th>
                  <th scope="col">{t('tokens.usage_heading')}</th>
                  <th scope="col">{t('tokens.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {tokens.map((token) => (
                  <tr key={token.id}>
                    <th scope="row">{token.name}</th>
                    <td>{token.abilities.join(', ')}</td>
                    <td>
                      {token.lastUsedAt ? t('tokens.last_used', { at: `${at(token.lastUsedAt)} UTC` }) : t('tokens.never_used')}
                      {token.expiresAt && ` · ${t('tokens.expires', { at: t.format.date(token.expiresAt, { dateStyle: 'medium', timeZone: 'UTC' }) })}`}
                    </td>
                    <td>
                      <Link
                        route="auth.tokens.destroy"
                        params={{ token: token.id }}
                        className="button-secondary"
                        data-destructive=""
                        confirm={{ title: t('tokens.revoke_title', { name: token.name }), message: t('tokens.revoke_confirm'), confirmLabel: t('tokens.revoke'), destructive: true }}
                      >
                        {t('tokens.revoke')}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="create-heading" className="card">
        <h2 id="create-heading">{t('tokens.create')}</h2>
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void form.submit({ onSuccess: () => form.reset() });
          }}
        >
          <div className="field">
            <label htmlFor="name">{t('tokens.name')}</label>
            <input id="name" value={form.data.name} onChange={(e) => form.set('name', e.target.value)} aria-invalid={!!form.errors.name} placeholder={t('tokens.name_placeholder')} />
            {form.errors.name && <small role="alert"> {form.errors.name}</small>}
          </div>
          <fieldset>
            <legend>{t('tokens.may')}</legend>
            {Object.entries(abilities).map(([ability, description]) => (
              <label key={ability} className="auth-choice">
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
          <button type="submit" className="button" disabled={form.processing}>
            {t('tokens.submit')}
          </button>
        </form>
      </section>
    </main>
  );
}

AccessTokens.layout = [AppLayout, SettingsLayout];

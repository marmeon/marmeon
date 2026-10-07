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
    <main>
      <Head title={t('tokens.title')} />
      <h1>{t('tokens.title')}</h1>
      {plainText && (
        <section aria-label={t('tokens.new')} role="alert">
          <p>
            <strong>{t('tokens.copy')}</strong>
          </p>
          <pre>
            <code>{plainText}</code>
          </pre>
          <p>
            {t('tokens.usage')} <code>curl -H "Authorization: Bearer {plainText.slice(0, 8)}…" /api/users</code>
          </p>
        </section>
      )}

      <h2>{t('tokens.yours')}</h2>
      {tokens.length === 0 ? (
        <p>{t('tokens.none')}</p>
      ) : (
        <ul>
          {tokens.map((token) => (
            <li key={token.id}>
              <strong>{token.name}</strong> — {token.abilities.join(', ')} ·{' '}
              {token.lastUsedAt ? t('tokens.last_used', { at: `${at(token.lastUsedAt)} UTC` }) : t('tokens.never_used')}
              {token.expiresAt && ` · ${t('tokens.expires', { at: t.format.date(token.expiresAt, { dateStyle: 'medium', timeZone: 'UTC' }) })}`}{' '}
              <Link
                route="auth.tokens.destroy"
                params={{ token: token.id }}
                confirm={{ title: t('tokens.revoke_title', { name: token.name }), message: t('tokens.revoke_confirm'), confirmLabel: t('tokens.revoke'), destructive: true }}
              >
                {t('tokens.revoke')}
              </Link>
            </li>
          ))}
        </ul>
      )}

      <h2>{t('tokens.create')}</h2>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void form.submit({ onSuccess: () => form.reset() });
        }}
      >
        <p>
          <label htmlFor="name">{t('tokens.name')}</label>
          <br />
          <input id="name" value={form.data.name} onChange={(e) => form.set('name', e.target.value)} aria-invalid={!!form.errors.name} placeholder={t('tokens.name_placeholder')} />
          {form.errors.name && <small role="alert"> {form.errors.name}</small>}
        </p>
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
        <button type="submit" disabled={form.processing}>
          {t('tokens.submit')}
        </button>
      </form>
    </main>
  );
}

AccessTokens.layout = [AppLayout, SettingsLayout];

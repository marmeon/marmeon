import type { PageProps } from '@bespokecore/http';
import { Head, Link, useForm } from '@bespokecore/react';
import type { ShowAccessTokensController } from '../controllers/ShowAccessTokensController.ts';

type Props = PageProps<ShowAccessTokensController>;

export default function AccessTokens({ tokens, abilities, plainText, flash }: Props) {
  const form = useForm('auth.tokens.store', { name: '', abilities: [] });
  const selected = [form.data.abilities ?? []].flat();

  return (
    <main>
      <Head title="API tokens" />
      <p>
        <Link route="auth.security">← Security</Link>
      </p>
      <h1>API tokens</h1>
      {flash.status && <p role="status">{flash.status}</p>}
      {plainText && (
        <section aria-label="New token" role="alert">
          <p>
            <strong>Copy your new token now — it will not be shown again:</strong>
          </p>
          <pre>
            <code>{plainText}</code>
          </pre>
          <p>
            Use it as <code>Authorization: Bearer …</code>, e.g. <code>curl -H "Authorization: Bearer {plainText.slice(0, 8)}…" /api/users</code>.
          </p>
        </section>
      )}

      <h2>Your tokens</h2>
      {tokens.length === 0 ? (
        <p>No tokens yet.</p>
      ) : (
        <ul>
          {tokens.map((token) => (
            <li key={token.id}>
              <strong>{token.name}</strong> — {token.abilities.join(', ')} · {token.lastUsedAt ? `last used ${token.lastUsedAt.slice(0, 16).replace('T', ' ')} UTC` : 'never used'}
              {token.expiresAt && ` · expires ${token.expiresAt.slice(0, 10)}`}{' '}
              <Link route="auth.tokens.destroy" params={{ token: token.id }}>
                Revoke
              </Link>
            </li>
          ))}
        </ul>
      )}

      <h2>Create a token</h2>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void form.submit({ onSuccess: () => form.reset() });
        }}
      >
        <p>
          <label htmlFor="name">Name</label>
          <br />
          <input id="name" value={form.data.name} onChange={(e) => form.set('name', e.target.value)} aria-invalid={!!form.errors.name} placeholder="e.g. Backup script" />
          {form.errors.name && <small role="alert"> {form.errors.name}</small>}
        </p>
        <fieldset>
          <legend>May</legend>
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
        <button type="submit" disabled={form.processing}>
          Create token
        </button>
      </form>
    </main>
  );
}

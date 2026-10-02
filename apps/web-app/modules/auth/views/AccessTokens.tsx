import type { PageProps } from '@bespokecore/http';
import { Head, Link, useAction, useRouter, useTranslation } from '@bespokecore/react';
import { ActionFailure } from '../../../layouts/ActionFailure.tsx';
import { AppLayout } from '../../../layouts/AppLayout.tsx';
import type { ShowAccessTokensController } from '../controllers/ShowAccessTokensController.ts';
import { SettingsLayout } from '../layouts/SettingsLayout.tsx';

type Props = PageProps<ShowAccessTokensController>;

export default function AccessTokens({ tokens }: Props) {
  const t = useTranslation('auth');
  // In UTC: the server and the browser render the same text (no time zone of either side).
  const at = (iso: string) => t.format.date(iso, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
  const router = useRouter<ShowAccessTokensController>();
  // Revoking is an action (E59): the token leaves the list at once — a snapshot patch of `tokens`, rolled back if the server
  // says no (someone else's id: 404; the password confirmation ran out: 423). It succeeded: the patch is the list now.
  const revoke = useAction('auth.tokens.destroy');
  const revokeToken = (id: number) =>
    void revoke.submit({ params: { token: id }, optimistic: router.optimistic((props) => ({ tokens: props.tokens.filter((token) => token.id !== id) })) });
  const failure = revoke.exception;

  return (
    <main>
      <Head title={t('tokens.title')} />
      <h1>{t('tokens.title')}</h1>
      {/* A layer over this list (E53): the form, then — replacing it — the new token's plain text, shown once. */}
      <p>
        <Link route="auth.tokens.create" layer>
          {t('tokens.create')}
        </Link>
      </p>

      <h2>{t('tokens.yours')}</h2>
      {revoke.result?.kind === 'data' && <p role="status">{t('tokens.revoked')}</p>}
      {/* Sudo mode ran out (423): confirm the password again — nothing is retried by itself. */}
      {failure?.type === 'server' && failure.status === 423 ? (
        <p role="alert">
          <Link route="auth.password.confirm">{t('tokens.confirm_again')}</Link>
        </p>
      ) : (
        <ActionFailure exception={failure} />
      )}
      {tokens.length === 0 ? (
        <p>{t('tokens.none')}</p>
      ) : (
        // A scrolling list of its own: Back and Forward restore its position, like the window's.
        <ul scroll-region="" style={{ maxHeight: '12rem', overflowY: 'auto' }}>
          {tokens.map((token) => (
            <li key={token.id}>
              <strong>{token.name}</strong> — {token.abilities.join(', ')} ·{' '}
              {token.lastUsedAt ? t('tokens.last_used', { at: `${at(token.lastUsedAt)} UTC` }) : t('tokens.never_used')}
              {token.expiresAt && ` · ${t('tokens.expires', { at: t.format.date(token.expiresAt, { dateStyle: 'medium', timeZone: 'UTC' }) })}`}{' '}
              <button type="button" onClick={() => revokeToken(token.id)}>
                {t('tokens.revoke')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

AccessTokens.layout = [AppLayout, SettingsLayout];

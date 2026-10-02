import type { PageProps } from '@bespokecore/http';
import { Head, Link, useTranslation } from '@bespokecore/react';
import { AppLayout } from '../../../layouts/AppLayout.tsx';
import type { ShowAccessTokensController } from '../controllers/ShowAccessTokensController.ts';
import { SettingsLayout } from '../layouts/SettingsLayout.tsx';

type Props = PageProps<ShowAccessTokensController>;

export default function AccessTokens({ tokens }: Props) {
  const t = useTranslation('auth');
  // In UTC: the server and the browser render the same text (no time zone of either side).
  const at = (iso: string) => t.format.date(iso, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });

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
              <Link route="auth.tokens.destroy" params={{ token: token.id }}>
                {t('tokens.revoke')}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

AccessTokens.layout = [AppLayout, SettingsLayout];

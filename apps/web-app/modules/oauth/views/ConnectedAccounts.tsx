import type { IslandProps } from '@marmeon/http';
import { Form, useTranslation } from '@marmeon/react';
import type { ShowConnectedAccountsController } from '../controllers/ShowConnectedAccountsController.ts';

/**
 * The accounts the person signs in with, and what they can do about them: connect another provider, remove one, and confirm it is them
 * (connecting and removing ask for that). Each action is a form, so it works without JavaScript too. Text and classes only: the look is your app's.
 */
export default function ConnectedAccounts({ accounts, providers, confirmed, hasPassword, hasPasskey, confirmUrl }: IslandProps<ShowConnectedAccountsController>) {
  const t = useTranslation('oauth');
  const day = (iso: string) => t.format.date(iso, { dateStyle: 'medium', timeZone: 'UTC' });
  const linked = new Set(accounts.map((account) => account.provider));
  const free = providers.filter((provider) => !linked.has(provider.name));
  const confirming = accounts.filter((account) => account.canConfirm);
  // A password or a passkey confirms on the confirmation page of the app; a provider that can prove a fresh sign-in confirms from here.
  const canConfirm = hasPassword || hasPasskey || confirming.length > 0;
  return (
    <section className="stack">
      <h2>{t('accounts.title')}</h2>
      <p className="muted">{t('accounts.intro')}</p>

      {accounts.length === 0 ? (
        <p>{t('accounts.none')}</p>
      ) : (
        <ul>
          {accounts.map((account) => (
            <li key={account.provider}>
              <strong>{account.label}</strong>
              {account.nickname ?? account.email ? ` · ${account.nickname ?? account.email}` : ''} · {t('accounts.connected_since', { date: day(account.createdAt) })}
              <Form route="oauth.unlink" params={{ provider: account.provider }} confirm={t('accounts.removing', { provider: account.label })}>
                <button type="submit" className="button-secondary">
                  {t('accounts.remove')}
                </button>
              </Form>
            </li>
          ))}
        </ul>
      )}

      {free.map((provider) => (
        <Form key={provider.name} route="oauth.link" params={{ provider: provider.name }}>
          <button type="submit" className="button-secondary">
            {t('accounts.connect', { provider: provider.label })}
          </button>
        </Form>
      ))}

      {confirmed ? (
        <p className="muted">{t('accounts.confirmed')}</p>
      ) : (
        <div className="stack">
          <h3>{t('accounts.confirm_title')}</h3>
          <p className="muted">{canConfirm ? t('accounts.confirm_needed') : t('accounts.no_confirmation')}</p>
          {confirming.map((account) => (
            <Form key={account.provider} route="oauth.confirm" params={{ provider: account.provider }}>
              <button type="submit" className="button-secondary">
                {t('accounts.confirm_with', { provider: account.label })}
              </button>
            </Form>
          ))}
          {hasPassword || hasPasskey ? (
            <a href={confirmUrl} className="button-secondary">
              {t('accounts.confirm_with_password')}
            </a>
          ) : null}
        </div>
      )}
    </section>
  );
}

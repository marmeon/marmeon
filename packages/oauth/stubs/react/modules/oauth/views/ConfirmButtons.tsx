import type { IslandProps } from '@marmeon/http';
import { Form, useTranslation } from '@marmeon/react';
import type { ShowConfirmButtonsController } from '../controllers/ShowConfirmButtonsController.ts';

/**
 * One button per linked account that can confirm it is you, for the confirmation page of your app, beside its password form. Each is a form
 * that posts to the module's start route. Text and classes only: the look is your app's.
 */
export default function ConfirmButtons({ providers }: IslandProps<ShowConfirmButtonsController>) {
  const t = useTranslation('oauth');
  if (providers.length === 0) return null;
  return (
    <div className="stack">
      <p className="muted">{t('confirm.title')}</p>
      {providers.map((provider) => (
        <Form key={provider.name} route="oauth.confirm" params={{ provider: provider.name }}>
          <button type="submit" className="button-secondary">
            {t('accounts.confirm_with', { provider: provider.label })}
          </button>
        </Form>
      ))}
    </div>
  );
}

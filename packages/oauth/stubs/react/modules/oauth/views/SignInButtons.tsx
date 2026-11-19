import type { IslandProps } from '@marmeon/http';
import { Form, useTranslation } from '@marmeon/react';
import type { ShowSignInButtonsController } from '../controllers/ShowSignInButtonsController.ts';

/**
 * One button per active provider. Each is a form that posts to the module's start route, so it works without JavaScript too. A guest's post carries no
 * token: the browser's Fetch Metadata (`Sec-Fetch-Site`) vouches for it (docs/security.md#requests-from-other-sites). Text and classes only: the look is your app's.
 */
export default function SignInButtons({ providers }: IslandProps<ShowSignInButtonsController>) {
  const t = useTranslation('oauth');
  if (providers.length === 0) return null;
  return (
    <div className="stack">
      {providers.map((provider) => (
        <Form key={provider.name} route="oauth.redirect" params={{ provider: provider.name }}>
          <button type="submit" className="button-secondary">
            {t('continue_with', { provider: provider.label })}
          </button>
        </Form>
      ))}
    </div>
  );
}

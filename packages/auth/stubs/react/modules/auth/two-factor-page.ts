import { TwoFactor } from '@marmeon/auth/two-factor';

/**
 * The layer that shows recovery codes once: it answers a POST (turning the factor on, making new codes) over the settings page,
 * so the codes never sit in the session, and when it closes they are gone from the tab's memory too.
 */
export const CODES_LAYER = { base: 'auth.two-factor', key: 'two-factor.codes' } as const;

/**
 * What the settings page shows. The key and QR code of a setup are in it only while the setup is unconfirmed: once the factor
 * is on they are not sent again.
 */
export async function twoFactorPage(twoFactor: TwoFactor) {
  const status = await twoFactor.status();
  return {
    enabled: status.factors.includes('totp'),
    setup: status.settingUpTotp ? ((await twoFactor.setup()) ?? null) : null,
    recoveryCodesLeft: status.recoveryCodesLeft,
  };
}

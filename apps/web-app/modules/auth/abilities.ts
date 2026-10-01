import type { Translator } from '@bespokecore/i18n';

/** What an API token of this app may be allowed to do — offered on the token page, checked by abilities(). */
export const TOKEN_ABILITIES = ['users:read'] as const;

export type TokenAbility = (typeof TOKEN_ABILITIES)[number];

/** The abilities with what they allow, in the request's language (`auth.tokens.abilities.*`). */
export function abilityDescriptions(translator: Translator): Record<TokenAbility, string> {
  return Object.fromEntries(TOKEN_ABILITIES.map((ability) => [ability, translator.get(`auth.tokens.abilities.${ability}`)])) as Record<TokenAbility, string>;
}

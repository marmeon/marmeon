/** What an API token of this app may be allowed to do — offered on the token page, checked by abilities(). */
export const TOKEN_ABILITIES = {
  'users:read': 'Read the directory of people (GET /api/users)',
} as const;

export type TokenAbility = keyof typeof TOKEN_ABILITIES;

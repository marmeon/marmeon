/**
 * The live channels of profiles: `users.<public_id>` — the profile page follows it (`.live()`), every write that changes what
 * it shows hints it (`broadcast.refresh(…, { only: ['profile'] })`): another tab on the profile reloads it, the tab that wrote
 * does not (it shows its own answer). The recent sign-ins (the dashboard's island, also on /people) follow `dashboard.sign-ins`.
 */
export const profileChannel = (publicId: string) => `users.${publicId}`;

export const SIGN_INS_CHANNEL = 'dashboard.sign-ins';

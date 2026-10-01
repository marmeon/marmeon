/** Where the reset link's token waits between the link and the form (encrypted like every cookie, path `/reset-password`). */
export const RESET_COOKIE = 'password_reset';

export function resetFromCookie(value: string | undefined): { email: string; token: string } | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as { email?: unknown; token?: unknown };
    return typeof parsed.email === 'string' && typeof parsed.token === 'string' ? { email: parsed.email, token: parsed.token } : undefined;
  } catch {
    return undefined;
  }
}

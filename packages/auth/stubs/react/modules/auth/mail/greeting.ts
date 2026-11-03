import type { Translator } from '@marmeon/i18n';
import type { User } from '../users.ts';

/**
 * The account's name for a mail to its address — `null` while that address is not confirmed. The name is the registrant's own text, and
 * whoever signed up with a stranger's address must not get words of their choosing into the app's mail to that inbox.
 */
export function confirmedName(user: Pick<User, 'name' | 'email_verified_at'>): string | null {
  return user.email_verified_at === null ? null : user.name;
}

/** The first line of a mail: "Hello Ada," — or "Hello," without a name (`confirmedName`). */
export function greeting(t: Translator, name: string | null): string {
  return name === null ? t.get('auth.mail.hello_unnamed') : t.get('auth.mail.hello', { name });
}

/** The recipient of a mail, named only with a name `confirmedName` gave. */
export function recipient(address: string, name: string | null): { address: string; name?: string } {
  return name === null ? { address } : { address, name };
}

import { Factories } from '@marmeon/database';
import { Translators } from '@marmeon/i18n';
import type { MailPreviewContext } from '@marmeon/mail';
import { AppConfig } from '../../../config/app.ts';
import { UserFactory } from '../factories/UserFactory.ts';
import type { User } from '../users.ts';

/**
 * Sample data for the mail previews (`/_marmeon/mail`, development only): a user from the factory — made, never
 * stored —, the translator of the preview's `?locale=`, and links from APP_URL.
 */
export function previewData({ make, locale }: MailPreviewContext) {
  const t = make(Translators).for(locale);
  const { name, email } = make(Factories).for(UserFactory).make({ name: 'Ada Lovelace', email: 'ada@example.com' });
  const now = new Date().toISOString();
  const user: User = { id: 1, public_id: '0190a000-0000-7000-8000-000000000001', name, email, bio: '', created_at: now, updated_at: now, email_verified_at: null, first_verified_at: null, locale: t.locale, avatar_path: null };
  return { t, user, url: (path: string) => new URL(path, make(AppConfig).url).href };
}

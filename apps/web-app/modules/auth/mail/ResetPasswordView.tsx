import type { Translator } from '@marmeon/i18n';
import { MjmlButton, MjmlText } from '@marmeon/react/mail';
import type { User } from '../users.ts';
import { confirmedName, greeting } from './greeting.ts';
import { Layout } from './Layout.tsx';

export function ResetPasswordView({ t, user, url, minutes }: { t: Translator; user: User; url: string; minutes: number }) {
  // React escapes texts and attributes: a name like "<b>" arrives as text, a quote in the link cannot leave href.
  return (
    <Layout t={t} preview={t.get('auth.mail.reset.preview')}>
      <MjmlText>{greeting(t, confirmedName(user))}</MjmlText>
      <MjmlText>{t.get('auth.mail.reset.intro')}</MjmlText>
      <MjmlButton href={url}>{t.get('auth.mail.reset.button')}</MjmlButton>
      <MjmlText>{t.get('auth.mail.reset.outro', { minutes })}</MjmlText>
    </Layout>
  );
}

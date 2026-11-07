import type { Translator } from '@marmeon/i18n';
import { MjmlButton, MjmlText } from '@marmeon/react/mail';
import type { User } from '../users.ts';
import { confirmedName, greeting } from './greeting.ts';
import type { SignIn } from './NewSignInMail.ts';
import { Layout } from './Layout.tsx';

export function NewSignInView({ t, user, signIn, url }: { t: Translator; user: User; signIn: SignIn; url: string }) {
  const { at, ip, browser } = signIn;
  // In UTC: a worker has no time zone of the user's.
  const when = t.format.date(at, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
  return (
    <Layout t={t} preview={t.get('auth.mail.new_sign_in.preview')}>
      <MjmlText>{greeting(t, confirmedName(user))}</MjmlText>
      <MjmlText>{t.get('auth.mail.new_sign_in.intro', { app: t.get('app.name') })}</MjmlText>
      <MjmlText>{t.get('auth.mail.new_sign_in.details', { at: `${when} UTC`, ip: ip ?? '—', browser: browser ?? '—' })}</MjmlText>
      <MjmlText>{t.get('auth.mail.new_sign_in.outro')}</MjmlText>
      <MjmlButton href={url}>{t.get('auth.mail.new_sign_in.button')}</MjmlButton>
    </Layout>
  );
}

import type { Translator } from '@marmeon/i18n';
import { MjmlButton, MjmlText } from '@marmeon/react/mail';
import { greeting } from './greeting.ts';
import { Layout } from './Layout.tsx';

export function ConfirmNewEmailView({ t, email, url }: { t: Translator; email: string; url: string }) {
  return (
    <Layout t={t} preview={t.get('auth.mail.confirm_new_email.preview')}>
      <MjmlText>{greeting(t, null)}</MjmlText>
      <MjmlText>{t.get('auth.mail.confirm_new_email.intro', { email })}</MjmlText>
      <MjmlButton href={url}>{t.get('auth.mail.confirm_new_email.button')}</MjmlButton>
      <MjmlText>{t.get('auth.mail.confirm_new_email.outro')}</MjmlText>
    </Layout>
  );
}

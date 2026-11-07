import type { Translator } from '@marmeon/i18n';
import { MjmlText } from '@marmeon/react/mail';
import type { User } from '../users.ts';
import { confirmedName, greeting } from './greeting.ts';
import { Layout } from './Layout.tsx';

export function EmailInUseView({ t, user }: { t: Translator; user: User }) {
  return (
    <Layout t={t} preview={t.get('auth.mail.email_in_use.preview')}>
      <MjmlText>{greeting(t, confirmedName(user))}</MjmlText>
      <MjmlText>{t.get('auth.mail.email_in_use.intro')}</MjmlText>
      <MjmlText>{t.get('auth.mail.email_in_use.outro')}</MjmlText>
    </Layout>
  );
}

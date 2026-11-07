import type { Translator } from '@marmeon/i18n';
import { MjmlButton, MjmlText } from '@marmeon/react/mail';
import type { User } from '../users.ts';
import { confirmedName, greeting } from './greeting.ts';
import { Layout } from './Layout.tsx';

export function WelcomeView({ t, user, url }: { t: Translator; user: User; url: string }) {
  return (
    <Layout t={t} preview={t.get('auth.mail.welcome.preview')}>
      <MjmlText>{greeting(t, confirmedName(user))}</MjmlText>
      <MjmlText>{t.get('auth.mail.welcome.intro', { app: t.get('app.name') })}</MjmlText>
      <MjmlButton href={url}>{t.get('auth.mail.welcome.button')}</MjmlButton>
      <MjmlText>{t.get('auth.mail.welcome.outro')}</MjmlText>
    </Layout>
  );
}

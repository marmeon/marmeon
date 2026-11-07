import type { Translator } from '@marmeon/i18n';
import { MjmlButton, MjmlText } from '@marmeon/react/mail';
import type { User } from '../users.ts';
import { confirmedName, greeting } from './greeting.ts';
import { Layout } from './Layout.tsx';

export function LockoutView({ t, user, forgot, login }: { t: Translator; user: User; forgot: string; login: string }) {
  return (
    <Layout t={t} preview={t.get('auth.mail.lockout.preview')}>
      <MjmlText>{greeting(t, confirmedName(user))}</MjmlText>
      <MjmlText>{t.get('auth.mail.lockout.intro')}</MjmlText>
      <MjmlButton href={forgot}>{t.get('auth.mail.lockout.button')}</MjmlButton>
      <MjmlText>
        {t.get('auth.mail.lockout.passkey')} <a href={login}>{login}</a>
      </MjmlText>
      <MjmlText>{t.get('auth.mail.lockout.outro')}</MjmlText>
    </Layout>
  );
}

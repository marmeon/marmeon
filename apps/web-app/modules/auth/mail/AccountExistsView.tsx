import type { Translator } from '@marmeon/i18n';
import { MjmlButton, MjmlText } from '@marmeon/react/mail';
import type { User } from '../users.ts';
import { confirmedName, greeting } from './greeting.ts';
import { Layout } from './Layout.tsx';

export function AccountExistsView({ t, user, login, forgot }: { t: Translator; user: User; login: string; forgot: string }) {
  return (
    <Layout t={t} preview={t.get('auth.mail.account_exists.preview')}>
      <MjmlText>{greeting(t, confirmedName(user))}</MjmlText>
      <MjmlText>{t.get('auth.mail.account_exists.intro')}</MjmlText>
      <MjmlButton href={login}>{t.get('auth.mail.account_exists.button')}</MjmlButton>
      <MjmlText>
        {t.get('auth.mail.account_exists.forgot')} <a href={forgot}>{forgot}</a>
      </MjmlText>
      <MjmlText>{t.get('auth.mail.account_exists.outro')}</MjmlText>
    </Layout>
  );
}

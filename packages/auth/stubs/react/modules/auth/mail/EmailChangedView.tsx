import type { Translator } from '@marmeon/i18n';
import { MjmlText } from '@marmeon/react/mail';
import { greeting } from './greeting.ts';
import { Layout } from './Layout.tsx';

export function EmailChangedView({ t, name, email }: { t: Translator; name: string | null; email: string }) {
  return (
    <Layout t={t} preview={t.get('auth.mail.email_changed.preview')}>
      <MjmlText>{greeting(t, name)}</MjmlText>
      <MjmlText>{t.get('auth.mail.email_changed.intro', { email })}</MjmlText>
      <MjmlText>{t.get('auth.mail.email_changed.outro')}</MjmlText>
    </Layout>
  );
}

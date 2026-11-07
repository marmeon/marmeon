import type { Translator } from '@marmeon/i18n';
import { MjmlButton, MjmlText } from '@marmeon/react/mail';
import { greeting } from './greeting.ts';
import { Layout } from './Layout.tsx';

export function VerifyEmailView({ t, url }: { t: Translator; url: string }) {
  return (
    <Layout t={t} preview={t.get('auth.mail.verify.preview')}>
      <MjmlText>{greeting(t, null)}</MjmlText>
      <MjmlText>{t.get('auth.mail.verify.intro')}</MjmlText>
      <MjmlButton href={url}>{t.get('auth.mail.verify.button')}</MjmlButton>
      <MjmlText>{t.get('auth.mail.verify.outro')}</MjmlText>
    </Layout>
  );
}

import type { Translator } from '@marmeon/i18n';
import { MjmlText } from '@marmeon/react/mail';
import { Layout } from './Layout.tsx';

export function NoteSharedView({ t, title }: { t: Translator; title: string }) {
  return (
    <Layout t={t} preview={t.get('notes.mail.shared.subject')}>
      <MjmlText>{t.get('notes.mail.shared.intro', { title })}</MjmlText>
    </Layout>
  );
}

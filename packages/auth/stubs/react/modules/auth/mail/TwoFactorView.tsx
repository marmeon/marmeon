import type { Translator } from '@marmeon/i18n';
import { MjmlText } from '@marmeon/react/mail';
import type { User } from '../users.ts';
import { confirmedName, greeting } from './greeting.ts';
import type { TwoFactorNotice } from './TwoFactorMail.ts';
import { Layout } from './Layout.tsx';

export function TwoFactorView({ t, user, notice }: { t: Translator; user: User; notice: TwoFactorNotice }) {
  const key = `auth.mail.two_factor.${notice.kind}` as const;
  // Only what the kind has to say is passed on; the others ignore the values.
  const values = { remaining: notice.kind === 'recovery_used' ? notice.remaining : 0, at: notice.kind === 'failed' ? `${notice.at.slice(0, 16).replace('T', ' ')} UTC` : '', from: notice.kind === 'failed' && notice.ip !== null ? t.get('auth.mail.two_factor.failed.from', { ip: notice.ip }) : '' };
  return (
    <Layout t={t} preview={t.get(`${key}.preview`)}>
      <MjmlText>{greeting(t, confirmedName(user))}</MjmlText>
      <MjmlText>{t.get(`${key}.intro`, values)}</MjmlText>
      <MjmlText>{t.get(`${key}.outro`)}</MjmlText>
    </Layout>
  );
}

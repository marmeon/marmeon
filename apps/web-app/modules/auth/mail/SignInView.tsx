import { describeDevice } from '@marmeon/auth';
import type { Translator } from '@marmeon/i18n';
import { MjmlText } from '@marmeon/react/mail';
import type { User } from '../users.ts';
import { confirmedName, greeting } from './greeting.ts';
import type { SignInNotice } from './SignInMail.ts';
import { Layout } from './Layout.tsx';

export function SignInView({ t, user, notice }: { t: Translator; user: User; notice: SignInNotice }) {
  const { at, ip, userAgent, sessionsEnded } = notice;
  const key = `auth.mail.sign_in.${notice.kind}` as const;
  const { browser, system } = describeDevice(userAgent ?? undefined);
  // In UTC: a worker has no time zone of the user's.
  const when = `${t.format.date(at, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC`;
  const device = browser && system ? t.get(`${key}.device`, { browser, system }) : (browser ?? system);
  // Only what is known is said, like the address of the failed second factor.
  const from = ip === null ? '' : t.get(`${key}.from`, { ip });
  const using = device === undefined ? '' : t.get(`${key}.with`, { device });
  return (
    <Layout t={t} preview={t.get(`${key}.preview`)}>
      <MjmlText>{greeting(t, confirmedName(user))}</MjmlText>
      <MjmlText>{t.get(`${key}.intro`)} {t.get(sessionsEnded ? `${key}.ended` : `${key}.not_ended`)}</MjmlText>
      <MjmlText>{t.get(`${key}.details`, { at: when, from, with: using })}</MjmlText>
      <MjmlText>{t.get(sessionsEnded ? `${key}.outro` : `${key}.outro_not_ended`)}</MjmlText>
    </Layout>
  );
}

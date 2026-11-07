import type { Translator } from '@marmeon/i18n';
import { MjmlText } from '@marmeon/react/mail';
import type { User } from '../users.ts';
import { confirmedName, greeting } from './greeting.ts';
import type { PasskeyNotice } from './PasskeyMail.ts';
import { Layout } from './Layout.tsx';

export function PasskeyView({ t, user, notice }: { t: Translator; user: User; notice: PasskeyNotice }) {
  const key = `auth.mail.passkey.${notice.kind}` as const;
  // A passkey's name is its holder's own text and can be changed while the address is unconfirmed: to such an address no name goes out
  // (`confirmedName`), neither in the intro nor in the list.
  const named = confirmedName(user) !== null;
  // Only what the kind has to say is passed on; the others ignore the values. React escapes the names, the user's own text.
  const values = {
    name: named && (notice.kind === 'added' || notice.kind === 'suspended') ? (notice.name ?? '') : '',
    from: notice.kind === 'sign_in_failed' && notice.ip !== null ? t.get('auth.mail.passkey.sign_in_failed.from', { ip: notice.ip }) : '',
  };
  // A suspended passkey that is gone by now has no name to give.
  const unnamed = !named && (notice.kind === 'added' || notice.kind === 'suspended' || notice.kind === 'after_reset');
  const intro = unnamed || (notice.kind === 'suspended' && notice.name === null) ? t.get(`auth.mail.passkey.${notice.kind}.intro_unnamed` as 'auth.mail.passkey.suspended.intro_unnamed') : t.get(`${key}.intro`, values);
  return (
    <Layout t={t} preview={t.get(`${key}.preview`)}>
      <MjmlText>{greeting(t, confirmedName(user))}</MjmlText>
      <MjmlText>{intro}</MjmlText>
      {notice.kind === 'after_reset' && named ? (
        <MjmlText>
          <ul>
            {notice.names.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </MjmlText>
      ) : null}
      <MjmlText>{t.get(`${key}.outro`)}</MjmlText>
    </Layout>
  );
}

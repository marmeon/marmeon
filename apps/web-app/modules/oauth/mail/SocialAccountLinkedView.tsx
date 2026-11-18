import type { Translator } from '@marmeon/i18n';
import { MjmlAll, MjmlAttributes, MjmlBody, MjmlButton, MjmlColumn, MjmlDocument, MjmlHead, MjmlPreview, MjmlSection, MjmlText } from '@marmeon/react/mail';

export function SocialAccountLinkedView({ t, provider, account, at, appName }: { t: Translator; provider: string; account: string | null; at: Date; appName: string }) {
  // The instant in UTC, named as such: the mail is read anywhere.
  const time = `${t.format.date(at, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC`;
  const who = account === null ? '' : t.get('oauth.mail.linked.who', { account });
  return (
    <MjmlDocument lang={t.locale}>
      <MjmlHead>
        <MjmlPreview>{t.get('oauth.mail.linked.preview', { provider, app: appName })}</MjmlPreview>
        <MjmlAttributes>
          <MjmlAll fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif" />
          <MjmlText fontSize="15px" lineHeight="1.5" color="#1f2933" />
          <MjmlButton backgroundColor="#1f2933" color="#ffffff" borderRadius="6px" fontSize="15px" />
        </MjmlAttributes>
      </MjmlHead>
      <MjmlBody backgroundColor="#f4f5f7" width="560px">
        <MjmlSection backgroundColor="#ffffff" padding="24px">
          <MjmlColumn>
            <MjmlText>{t.get('oauth.mail.linked.hello')}</MjmlText>
            <MjmlText>{t.get('oauth.mail.linked.intro', { provider, who, time, app: appName })}</MjmlText>
            <MjmlText>{t.get('oauth.mail.linked.outro')}</MjmlText>
          </MjmlColumn>
        </MjmlSection>
      </MjmlBody>
    </MjmlDocument>
  );
}

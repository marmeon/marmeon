import type { Translator } from '@marmeon/i18n';
import { MjmlAll, MjmlAttributes, MjmlBody, MjmlButton, MjmlColumn, MjmlDocument, MjmlHead, MjmlPreview, MjmlSection, MjmlText } from '@marmeon/react/mail';

export function SocialAccountExistsView({ t, provider, login, appName }: { t: Translator; provider: string; login: string; appName: string }) {
  return (
    <MjmlDocument lang={t.locale}>
      <MjmlHead>
        <MjmlPreview>{t.get('oauth.mail.exists.preview', { provider })}</MjmlPreview>
        <MjmlAttributes>
          <MjmlAll fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif" />
          <MjmlText fontSize="15px" lineHeight="1.5" color="#1f2933" />
          <MjmlButton backgroundColor="#1f2933" color="#ffffff" borderRadius="6px" fontSize="15px" />
        </MjmlAttributes>
      </MjmlHead>
      <MjmlBody backgroundColor="#f4f5f7" width="560px">
        <MjmlSection backgroundColor="#ffffff" padding="24px">
          <MjmlColumn>
            <MjmlText>{t.get('oauth.mail.exists.hello')}</MjmlText>
            <MjmlText>{t.get('oauth.mail.exists.intro', { provider, app: appName })}</MjmlText>
            <MjmlButton href={login}>{t.get('oauth.mail.exists.button')}</MjmlButton>
            <MjmlText>{t.get('oauth.mail.exists.outro', { provider })}</MjmlText>
          </MjmlColumn>
        </MjmlSection>
      </MjmlBody>
    </MjmlDocument>
  );
}

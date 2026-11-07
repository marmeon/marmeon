import type { Translator } from '@marmeon/i18n';
import { MjmlAll, MjmlAttributes, MjmlBody, MjmlButton, MjmlColumn, MjmlDocument, MjmlHead, MjmlPreview, MjmlSection, MjmlText } from '@marmeon/react/mail';
import type { ReactNode } from 'react';

/**
 * The frame of every mail of the app — a component whose children are the mail's body, so a view nests into it. `t` speaks the
 * recipient's language (`translator.forLocale(user.locale)`), which also goes into `<mjml lang>`.
 */
export function Layout({ t, preview, children }: { t: Translator; preview: string; children: ReactNode }) {
  return (
    <MjmlDocument lang={t.locale}>
      <MjmlHead>
        <MjmlPreview>{preview}</MjmlPreview>
        <MjmlAttributes>
          <MjmlAll fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif" />
          <MjmlText fontSize="15px" lineHeight="1.5" color="#1f2933" />
          <MjmlButton backgroundColor="#1f2933" color="#ffffff" borderRadius="6px" fontSize="15px" />
        </MjmlAttributes>
      </MjmlHead>
      <MjmlBody backgroundColor="#f4f5f7" width="560px">
        <MjmlSection backgroundColor="#ffffff" padding="24px">
          <MjmlColumn>{children}</MjmlColumn>
        </MjmlSection>
        <MjmlSection padding="12px">
          <MjmlColumn>
            <MjmlText fontSize="12px" color="#7b8794" align="center">
              {t.get('auth.mail.app')}
            </MjmlText>
          </MjmlColumn>
        </MjmlSection>
      </MjmlBody>
    </MjmlDocument>
  );
}

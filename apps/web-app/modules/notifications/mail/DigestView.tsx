import type { Translator } from '@marmeon/i18n';
import { MjmlBody, MjmlColumn, MjmlDocument, MjmlSection, MjmlText } from '@marmeon/react/mail';

export interface DigestViewProps {
  readonly t: Translator;
  /** The signed link that leaves the list. */
  readonly url: string;
  /** What is new; none for a plain reminder. */
  readonly items: readonly string[];
}

/** The body of `DigestMail`: a React component, rendered to MJML by `toMjml` — React escapes every name, so a title cannot add markup. */
export function DigestView({ t, url, items }: DigestViewProps) {
  return (
    <MjmlDocument lang={t.locale}>
      <MjmlBody>
        <MjmlSection>
          <MjmlColumn>
            <MjmlText>{t.get('notifications.mail.digest.intro')}</MjmlText>
            {items.map((item) => (
              <MjmlText key={item} paddingTop={0} paddingBottom={0}>
                {item}
              </MjmlText>
            ))}
            <MjmlText>
              <a href={url}>{t.get('notifications.mail.digest.unsubscribe')}</a>
            </MjmlText>
          </MjmlColumn>
        </MjmlSection>
      </MjmlBody>
    </MjmlDocument>
  );
}

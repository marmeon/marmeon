import type { MailSent } from './index.ts';

export function mailSentCarriesNoContent(event: MailSent): void {
  // @ts-expect-error a MailSent has no html: a link in a mail must not reach listeners
  void event.html;
  // @ts-expect-error a MailSent has no text
  void event.text;
  // @ts-expect-error a MailSent has no headers
  void event.headers;
  // @ts-expect-error a MailSent has no attachments
  void event.attachments;
  // @ts-expect-error the addresses are read-only
  event.to.push('x@example.com');
}

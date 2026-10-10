import type { Application } from '@marmeon/core';
import { channels, messageBase, trace, type MailSendMessage } from '@marmeon/core/diagnostics';
import type { MailMessage } from './message.ts';

const sends = channels.tracing('mail.send');

/**
 * Runs `send` on the `mail.send` channel while something listens — the recipients, subject and body filled in from
 * the composed message (raw: the devtools redact it). Without a subscriber (or an app) it just runs.
 */
export function traceMail(app: Application | undefined, mailable: string, mode: MailSendMessage['mode'], send: () => Promise<MailMessage>): Promise<MailMessage> {
  if (!app || !sends.hasSubscribers) return send();
  return trace(sends, { ...messageBase(app), mailable, mode }, send, (ended, message) => {
    ended.to = message.to.map((to) => to.address);
    ended.subject = message.subject;
    ended.from = message.from.address;
    ended.cc = message.cc.map((cc) => cc.address);
    ended.bcc = message.bcc.map((bcc) => bcc.address);
    ended.html = message.html;
    ended.text = message.text;
    ended.attachments = message.attachments.map((attachment) => ({
      filename: attachment.filename,
      bytes: typeof attachment.content === 'string' ? Buffer.byteLength(attachment.content) : attachment.content.byteLength,
      ...(attachment.contentType ? { contentType: attachment.contentType } : {}),
    }));
  });
}

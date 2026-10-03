import type { Application } from '@bespokecore/core';
import { channels, messageBase, trace, type MailSendMessage } from '@bespokecore/core/diagnostics';
import type { MailMessage } from './message.ts';

const sends = channels.tracing('mail.send');

/**
 * Runs `send` on the `mail.send` channel while something listens (E118) — the recipients and subject filled in from the
 * composed message. Without a subscriber (or an app) it just runs.
 */
export function traceMail(app: Application | undefined, mailable: string, mode: MailSendMessage['mode'], send: () => Promise<MailMessage>): Promise<MailMessage> {
  if (!app || !sends.hasSubscribers) return send();
  return trace(sends, { ...messageBase(app), mailable, mode }, send, (ended, message) => {
    ended.to = message.to.map((to) => to.address);
    ended.subject = message.subject;
  });
}

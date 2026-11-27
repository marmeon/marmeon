import { Logger, type LogContext } from '@marmeon/core';
import { Mailer, type Mailable } from '@marmeon/mail';
import { createTestApp } from '@marmeon/testing';
import { expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';

class PingMail implements Mailable {
  envelope() {
    return { to: 'ada@example.com', subject: 'A subject that names Ada' };
  }
  content() {
    return { html: '<p>Ping</p>', text: 'Ping' };
  }
}

type Entry = { level: string; message: string; context: LogContext };

function recordingLogger(entries: Entry[], bindings: LogContext = {}): Logger {
  const log = (level: string) => (message: string, context: LogContext = {}) => void entries.push({ level, message, context: { ...bindings, ...context } });
  return { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error'), child: (more) => recordingLogger(entries, { ...bindings, ...more }) };
}

it('logs the mailable and the message id of a sent mail on the mail channel, without address or subject', async () => {
  const entries: Entry[] = [];
  const app = await createTestApp(application, { mail: 'real', env: { MAIL_DRIVER: 'scratch' }, override: (container) => container.instance(Logger, recordingLogger(entries)) });
  const sent = await app.make(Mailer).send(new PingMail());
  const line = entries.find((entry) => entry.message.startsWith('Mail sent: '));
  expect(line).toMatchObject({ level: 'info', message: `Mail sent: PingMail (${sent.messageId})`, context: { channel: 'mail' } });
  expect(JSON.stringify(entries.filter((entry) => entry.message.startsWith('Mail sent: ')))).not.toMatch(/ada@example\.com|names Ada/);
  await app.close();
});

import { Translators } from '@marmeon/i18n';
import { Mailer } from '@marmeon/mail';
import { createTestApp } from '@marmeon/testing';
import { it, vi } from 'vitest';
import application from '../../bootstrap/app.ts';
import { NoteSharedMail } from './mail/NoteSharedMail.ts';

// Booting the app on a refreshed database takes seconds on a busy machine.
vi.setConfig({ testTimeout: 30_000 });

it('composes the mail about a shared note for its recipient', async () => {
  const app = await createTestApp(application, { database: 'refresh' });
  const t = app.make(Translators).for('en');
  await app.make(Mailer).send(new NoteSharedMail('bob@example.com', 'Groceries', t));
  app.mail.assertSent(NoteSharedMail, (_mail, message) => message.to[0]!.address === 'bob@example.com' && message.subject === 'A note was shared with you');
});

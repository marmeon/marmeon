import { MailTransport } from '@bespokecore/mail';
import { QueueConnections } from '@bespokecore/queue';
import { createTestApp } from '@bespokecore/testing';
import application from '../../bootstrap/app.ts';

/** How long {@link warmUp} may take — a hook's own time, not a test's 5 s. */
export const WARM_UP_TIMEOUT = 60_000;

const password = 'warming up the queue';
const form = { name: 'Warm Up', email: 'warm-up@example.com', password, password_confirmation: password };

/**
 * For a test file's `beforeAll(warmUp, WARM_UP_TIMEOUT)` (W9 step 1): what the file's first tests would otherwise pay inside Vitest's
 * 5 s — the worker's database (created and migrated once per worker), the app's modules, a registration (the password hash) and
 * its jobs, through the fakes and through the real database queue and mailer (their drivers, mjml's import and first compile, the
 * mails' translations). Seconds on a loaded machine; afterwards every test pays only for its own work. Each app is closed again:
 * its transaction rolls back, nothing stays.
 */
export async function warmUp(): Promise<void> {
  const fake = await createTestApp(application, { database: 'refresh' });
  try {
    await fake.post('/register', { form }).assertRedirect('/register/sent');
    await fake.queue.work();
  } finally {
    await fake.close();
  }
  const real = await createTestApp(application, {
    database: 'refresh',
    queue: 'real',
    mail: 'real',
    override: (container) => container.instance(MailTransport, { send: async () => {} }),
  });
  try {
    await real.post('/register', { form }).assertRedirect('/register/sent');
    await real.make(QueueConnections).worker('database', 10).run({ queues: ['*'], stopWhenEmpty: true });
  } finally {
    await real.close();
  }
}

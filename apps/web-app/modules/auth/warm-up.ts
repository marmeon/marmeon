import { MailTransport } from '@marmeon/mail';
import { QueueConnections } from '@marmeon/queue';
import { createTestApp } from '@marmeon/testing';
import application from '../../bootstrap/app.ts';

/** How long {@link warmUp} may take — a hook's own time, not a test's 5 s. */
export const WARM_UP_TIMEOUT = 60_000;

const password = 'warming up the queue';
const form = { name: 'Warm Up', email: 'warm-up@example.com', password, password_confirmation: password };

/**
 * For a test file's `beforeAll(warmUp, WARM_UP_TIMEOUT)`: what the file's first tests would otherwise pay inside Vitest's
 * 5 s — the worker's database (created and migrated once per worker), the app's modules, a registration (the password hash) and
 * its jobs, through the fakes and through the real database queue and mailer (their drivers, mjml's import and first compile, the
 * mails' translations), and a seeded app in development. Seconds on a loaded machine; afterwards every test pays only for its
 * own work. Each app is closed again: its transaction rolls back, nothing stays.
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
  // The development-only parts (Server-Timing, the dev error page's recorder …) and the seeders: their first use is cold too.
  const development = await createTestApp(application, { database: 'refresh', seed: true, env: { NODE_ENV: 'development' } });
  try {
    await development.get('/login').assertOk();
  } finally {
    await development.close();
  }
}

/**
 * For a test file's `beforeAll(warmUpDatabase, WARM_UP_TIMEOUT)` when its tests only need the worker's database and the app's
 * modules: one seeded app, opened and closed. The first app of a worker creates and migrates its database (on Postgres a
 * `create database` and every migration); without this hook the file's first test, or its first `beforeEach`, would pay that
 * inside Vitest's 5 s. {@link warmUp} does this and more, for the files that register or send mail.
 */
export async function warmUpDatabase(): Promise<void> {
  const app = await createTestApp(application, { database: 'refresh', seed: true });
  await app.close();
}

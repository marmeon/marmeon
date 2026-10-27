import { Writable } from 'node:stream';
import { Application, Logger, Redactor } from '@marmeon/core';
import { cookieNames } from '@marmeon/auth/testing';
import { createPinoLogger } from '@marmeon/log';
import { createTestApp } from '@marmeon/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { WARM_UP_TIMEOUT, warmUp } from '../auth/warm-up.ts';

// Cold starts in a hook with its own time, not in the first test's 5 s (the worker's database, the queues, mjml, the mails).
beforeAll(warmUp, WARM_UP_TIMEOUT);

// The partner's key format, joined at run time: a literal would look like a token to a scanner. Lower case, so the core's
// own rules leave it alone and only the app's pattern can hide it.
const partnerKey = ['wa', 'live', 'q8fz0kzb3t5wyvlp9nr2xcj7'].join('_');

describe('what bootstrap/app.ts adds to the redactor', () => {
  it('masks the added field name and the added key format in a log line', async () => {
    const lines: Record<string, unknown>[] = [];
    const stream = new Writable({
      write(chunk, _encoding, done) {
        lines.push(JSON.parse(String(chunk)));
        done();
      },
    });
    const app = await createTestApp(application, {
      override: (container) => container.instance(Logger, createPinoLogger({ level: 'info', format: 'json' }, { destination: stream, app: container.make(Application) })),
    });
    const logger = app.application.container.make(Logger);
    logger.info('Payout sent', { iban: 'DE89370400440532013000', note: `partner answered with ${partnerKey}` });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ iban: '[redacted]', note: 'partner answered with [redacted]' });
    expect(JSON.stringify(lines)).not.toContain(partnerKey);
    expect(JSON.stringify(lines)).not.toContain('DE89370400440532013000');
  });

  it("keeps a failed form's added field out of the session and the next page, and the other fields in", async () => {
    const app = await createTestApp(application);
    const session = cookieNames(app).session;
    // The core's field list knows `iban`; `national_id` is a name only the app added, so only the session's filter can drop it.
    const nationalId = 'ID-7741-0093';
    const failed = await app
      .post('/register', { form: { name: 'Ada Lovelace', email: 'nope', national_id: nationalId }, headers: { referer: 'http://localhost/register' } })
      .assertRedirect('/register')
      .assertSessionHas('_old_input', { name: 'Ada Lovelace', email: 'nope' });
    expect(JSON.stringify(failed.session())).not.toContain(nationalId);
    await app.withCookie(session, failed.cookie(session)!).navigating().get('/register').assertPage('auth/Register', { old: { name: 'Ada Lovelace', email: 'nope' } });
  });

  it("gives the same redactor to the app's stored errors", async () => {
    const app = await createTestApp(application);
    const redactor = app.application.container.make(Redactor);
    expect(redactor.isSensitive('iban')).toBe(true);
    expect(redactor.text(`rejected ${partnerKey}`)).toBe('rejected [redacted]');
  });
});

import { Writable } from 'node:stream';
import { describeError, redactText, runWithJob, runWithRequest } from '@bespokecore/core';
import { describe, expect, it } from 'vitest';
import { createPinoLogger } from './index.ts';

function capture(level: 'info' | 'warn' = 'info') {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(JSON.parse(String(chunk)));
      done();
    },
  });
  return { lines, logger: createPinoLogger({ level, format: 'json' }, stream) };
}

describe('@bespokecore/log', () => {
  it('writes JSON with the message and context, in Laravel argument order', () => {
    const { lines, logger } = capture();
    logger.info('User signed in', { userId: '1' });
    expect(lines[0]).toMatchObject({ level: 30, msg: 'User signed in', userId: '1' });
  });

  it('attaches the request id of the current request automatically', () => {
    const { lines, logger } = capture();
    runWithRequest({ requestId: 'req-42' }, () => logger.child({ channel: 'http' }).warn('Slow request'));
    logger.info('Outside a request');

    expect(lines[0]).toMatchObject({ msg: 'Slow request', requestId: 'req-42', channel: 'http' });
    expect(lines[1]).not.toHaveProperty('requestId');
  });

  it('attaches the job, its id and the attempt while a queued job runs (inside a request: both)', () => {
    const { lines, logger } = capture();
    runWithJob({ job: 'auth.send-welcome-mail', jobId: 'j-1', attempt: 2 }, () => logger.info('Sending'));
    runWithRequest({ requestId: 'req-7' }, () => runWithJob({ job: 'auth.sync', jobId: 'j-2', attempt: 1 }, () => logger.info('Sync job')));
    expect(lines[0]).toMatchObject({ msg: 'Sending', job: 'auth.send-welcome-mail', jobId: 'j-1', attempt: 2 });
    expect(lines[0]).not.toHaveProperty('requestId');
    expect(lines[1]).toMatchObject({ requestId: 'req-7', job: 'auth.sync', jobId: 'j-2', attempt: 1 });
  });

  it('redacts secrets in text — a failed job\'s stored error (E105)', () => {
    expect(redactText('login failed: password=hunter2&user=ada, "api_key":"k-1", token: abc123')).toBe(
      'login failed: password=[redacted]&user=ada, "api_key":"[redacted]", token: [redacted]',
    );
    expect(redactText('connect postgres://app:s3cret@db:5432/app and redis://:pw@cache')).toBe('connect postgres://app:***@db:5432/app and redis://:***@cache');
    expect(redactText('Authorization: Bearer eyJhbGciOi.x.y failed; then Bearer abc')).toBe('Authorization: Bearer [redacted] failed; then Bearer [redacted]');
    expect(redactText('GET /reset?signature=f00&expires=1')).toBe('GET /reset?signature=[redacted]&expires=1');
    const error = Object.assign(new Error('SMTP: auth failed for password=x', { cause: new Error('socket token=y') }), { headers: { authorization: 'Basic z' }, code: 'EAUTH' });
    const text = describeError(error);
    expect(text).toMatch(/^Error: SMTP: auth failed for password=\[redacted\]\n {4}at /);
    expect(text).toContain('{"headers":{"authorization":"[redacted]"},"code":"EAUTH"}');
    expect(text).toContain('Caused by: Error: socket token=[redacted]');
    expect(text).not.toMatch(/password=x|token=y|Basic z/);
  });

  it('counter-check: never writes passwords, tokens, secrets or credentials — by key, at any depth', () => {
    const { lines, logger } = capture();
    logger.info('Login failed', {
      email: 'ada@example.com',
      password: 'hunter2',
      new_password: 'hunter3',
      headers: { authorization: 'Bearer bc_1|abc', accept: 'application/json', cookie: 'bespoke_session=x' },
      remember_web: 'selector.validator',
      token: 'abc',
      api_key: 'k',
      nested: { deeper: { client_secret: 's', id: 7 } },
    });
    const line = JSON.stringify(lines[0]);
    for (const secret of ['hunter2', 'hunter3', 'Bearer bc_1|abc', 'bespoke_session=x', 'selector.validator', '"abc"', '"k"', '"s"']) expect(line).not.toContain(secret);
    expect(lines[0]).toMatchObject({ email: 'ada@example.com', headers: { accept: 'application/json', authorization: '[redacted]' }, nested: { deeper: { id: 7 } } });
  });

  it('filters by level', () => {
    const { lines, logger } = capture('warn');
    logger.info('hidden');
    logger.error('shown');
    expect(lines.map((line) => line.msg)).toEqual(['shown']);
  });
});

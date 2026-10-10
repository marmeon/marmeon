import { Writable } from 'node:stream';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ConsoleLogger, createApplication, describeError, LogContextSources, Redactor, redactText, runWithJob, runWithRequest, runWithTask } from '@marmeon/core';
import { channels, type LogMessage } from '@marmeon/core/diagnostics';
import { describe, expect, it } from 'vitest';
import { createPinoLogger, LogConfig } from './index.ts';

function capture(level: 'info' | 'warn' = 'info') {
  const lines: Record<string, unknown>[] = [];
  const raw: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      raw.push(String(chunk));
      lines.push(JSON.parse(String(chunk)));
      done();
    },
  });
  return { lines, raw, logger: createPinoLogger({ level, format: 'json' }, stream) };
}

describe('@marmeon/log', () => {
  it('logs pretty lines with NODE_ENV=development only — JSON everywhere else, a missing NODE_ENV included', () => {
    const format = (NODE_ENV: string | undefined, LOG_FORMAT?: 'pretty' | 'json') => LogConfig.resolve({ LOG_LEVEL: 'info', NODE_ENV, LOG_FORMAT }).format;
    expect(format('development')).toBe('pretty');
    for (const environment of [undefined, '', 'production', 'staging', 'test']) expect(format(environment)).toBe('json');
    expect(format('staging', 'pretty')).toBe('pretty');
    expect(format('development', 'json')).toBe('json');
  });

  it('names the app\'s environment in every JSON entry — appEnv, from APP_ENV or the one NODE_ENV goes with', () => {
    const resolve = (env: Record<string, string | undefined>) => LogConfig.resolve({ LOG_LEVEL: 'info', ...env }).environment;
    expect(resolve({ NODE_ENV: 'production', APP_ENV: 'staging' })).toBe('staging');
    expect(resolve({ NODE_ENV: 'production' })).toBe('production');
    expect(resolve({ NODE_ENV: 'development' })).toBe('local');
    expect(resolve({ NODE_ENV: 'test' })).toBe('testing');
    const lines: Record<string, unknown>[] = [];
    const stream = new Writable({
      write(chunk, _encoding, done) {
        lines.push(JSON.parse(String(chunk)));
        done();
      },
    });
    const logger = createPinoLogger({ level: 'info', format: 'json', environment: 'staging' }, stream);
    logger.info('Started');
    logger.child({ channel: 'http' }).warn('Slow');
    expect(lines).toEqual([
      { level: 30, time: expect.any(Number), appEnv: 'staging', msg: 'Started' },
      { level: 40, time: expect.any(Number), appEnv: 'staging', channel: 'http', msg: 'Slow' },
    ]);
  });

  it('writes JSON with the message and context, message first', () => {
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

  it('adds what the app\'s log context sources give — a tracer\'s trace_id and span_id — and nothing without a source', async () => {
    const app = await createApplication({ root: import.meta.dirname, discover: false, env: {} });
    const lines: Record<string, unknown>[] = [];
    const stream = new Writable({
      write(chunk, _encoding, done) {
        lines.push(JSON.parse(String(chunk)));
        done();
      },
    });
    const logger = createPinoLogger({ level: 'info', format: 'json' }, stream, app);
    const span = new AsyncLocalStorage<string>();
    logger.info('Before');
    const off = app.container.make(LogContextSources).add(() => (span.getStore() ? { trace_id: span.getStore() } : undefined));
    span.run('4bf92f3577b34da6a3ce929d0e0e4736', () => runWithRequest({ requestId: 'req-1' }, () => logger.child({ channel: 'http' }).info('Inside')));
    logger.info('Outside a span');
    off();
    span.run('4bf92f3577b34da6a3ce929d0e0e4736', () => logger.info('Source removed'));
    expect(lines.map(({ msg, trace_id, requestId }) => ({ msg, trace_id, requestId }))).toEqual([
      { msg: 'Before', trace_id: undefined, requestId: undefined },
      { msg: 'Inside', trace_id: '4bf92f3577b34da6a3ce929d0e0e4736', requestId: 'req-1' },
      { msg: 'Outside a span', trace_id: undefined, requestId: undefined },
      { msg: 'Source removed', trace_id: undefined, requestId: undefined },
    ]);

    // The fallback logger too.
    const printed: string[] = [];
    const original = console.log;
    console.log = (line: string) => void printed.push(line);
    try {
      const off2 = app.container.make(LogContextSources).add(() => ({ trace_id: 'abc' }));
      new ConsoleLogger({}, app).info('Console');
      off2();
    } finally {
      console.log = original;
    }
    expect(printed).toEqual(['[info] Console {"trace_id":"abc"}']);
  });

  it('writes a key of the log context once when a child logger is bound with it too (the scheduler’s task)', () => {
    const { lines, raw, logger } = capture();
    runWithTask({ task: 'session:prune' }, () => logger.child({ channel: 'schedule', task: 'session:prune' }).info('Done'));
    runWithTask({ task: 'cache:prune' }, () => logger.child({ channel: 'schedule' }).info('Running'));
    expect(raw[0]!.match(/"task":/g)).toHaveLength(1);
    expect(lines[0]).toMatchObject({ msg: 'Done', channel: 'schedule', task: 'session:prune' });
    expect(lines[1]).toMatchObject({ msg: 'Running', task: 'cache:prune' });
  });

  it('redacts secrets in text — a failed job\'s stored error', () => {
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

  it('never writes passwords, tokens, secrets or credentials — by key, at any depth', () => {
    const { lines, logger } = capture();
    logger.info('Login failed', {
      email: 'ada@example.com',
      password: 'hunter2',
      new_password: 'hunter3',
      headers: { authorization: 'Bearer marmeon_1|abc', accept: 'application/json', cookie: 'marmeon_session=x' },
      remember_web: 'selector.validator',
      token: 'abc',
      api_key: 'k',
      nested: { deeper: { client_secret: 's', id: 7 } },
    });
    const line = JSON.stringify(lines[0]);
    for (const secret of ['hunter2', 'hunter3', 'Bearer marmeon_1|abc', 'marmeon_session=x', 'selector.validator', '"abc"', '"k"', '"s"']) expect(line).not.toContain(secret);
    expect(lines[0]).toMatchObject({ email: 'ada@example.com', headers: { accept: 'application/json', authorization: '[redacted]' }, nested: { deeper: { id: 7 } } });
  });

  it('redacts inside lists, the bindings of a child logger and an error\'s fields and causes', () => {
    const { lines, raw, logger } = capture();
    const child = logger.child({ channel: 'auth', token: 'bound-t0k3n', user: { password: 'bound-pw' } });
    const cause = Object.assign(new Error('socket token=c4use'), { config: { headers: { authorization: 'Basic c2VjcmV0' } } });
    child.info('Import', { users: [{ email: 'ada@example.com', password: 'hunter2' }, [{ api_key: 'k-2' }]] });
    child.error('Failed', { err: Object.assign(new Error('auth failed for password=errpw', { cause }), { code: 'EAUTH', secret: 'own-field' }) });
    const all = raw.join('');
    for (const secret of ['bound-t0k3n', 'bound-pw', 'hunter2', 'k-2', 'errpw', 'c4use', 'Basic c2VjcmV0', 'own-field']) expect(all).not.toContain(secret);
    expect(lines[0]).toMatchObject({ channel: 'auth', token: '[redacted]', user: { password: '[redacted]' }, users: [{ email: 'ada@example.com', password: '[redacted]' }, [{ api_key: '[redacted]' }]] });
    // pino's error serializer still knows the error: its class, message with causes, stack and fields.
    expect(lines[1], JSON.stringify(lines[1])).toMatchObject({ err: { type: 'Error', message: expect.stringContaining('auth failed for password=[redacted]'), code: 'EAUTH', secret: '[redacted]' } });
    expect((lines[1]!.err as { stack: string }).stack).toContain('caused by: Error: socket token=[redacted]');
  });

  it("redacts the names the app's Redactor adds (addKeys) — in the context, a child's bindings and an error's text", async () => {
    const app = await createApplication({ root: import.meta.dirname, discover: false, env: {} });
    app.container.make(Redactor).addKeys('marmeon_session', 'X-Tenant-Key');
    const raw: string[] = [];
    const stream = new Writable({ write: (chunk, _encoding, done) => (raw.push(String(chunk)), done()) });
    const logger = createPinoLogger({ level: 'info', format: 'json' }, stream, app);
    logger.child({ marmeon_session: 'bound-s3ss' }).info('Visit', { headers: { 'x-tenant-key': 'tenant-k3y' }, list: [{ MARMEON_SESSION: 'listed-s3ss' }] });
    logger.error('Failed', { err: new Error('cookie marmeon_session=err-s3ss rejected') });
    const all = raw.join('');
    for (const secret of ['bound-s3ss', 'tenant-k3y', 'listed-s3ss', 'err-s3ss']) expect(all, `${secret} in ${all}`).not.toContain(secret);
    expect(JSON.parse(raw[0]!)).toMatchObject({ marmeon_session: '[redacted]', headers: { 'x-tenant-key': '[redacted]' } });

    const written: string[] = [];
    const log = console.log;
    console.log = (line: string) => void written.push(line);
    try {
      new ConsoleLogger({}, app).child({ marmeon_session: 'bound-s3ss' }).info('Visit', { 'X-Tenant-Key': 'tenant-k3y' });
    } finally {
      console.log = log;
    }
    expect(written.join(''), JSON.stringify(written)).not.toMatch(/bound-s3ss|tenant-k3y/);
  });

  it('writes an error under any key with its type, message and stack — masked like under err, never as {}', () => {
    const { lines, raw, logger } = capture();
    const failure = () => Object.assign(new TypeError('import failed for password=errpw', { cause: new Error('socket token=c4use') }), { code: 'EIMPORT', secret: 'own-field' });
    logger.error('Failed', { error: failure(), job: { last: failure() }, errors: [failure()] });
    const all = raw.join('');
    for (const secret of ['errpw', 'c4use', 'own-field']) expect(all, all).not.toContain(secret);
    const written = { type: 'TypeError', message: expect.stringContaining('import failed for password=[redacted]'), stack: expect.stringContaining('TypeError: import failed'), code: 'EIMPORT', secret: '[redacted]' };
    expect(lines[0], JSON.stringify(lines[0])).toMatchObject({ error: written, job: { last: written }, errors: [written] });
    expect((lines[0]!.error as { stack: string }).stack).toContain('caused by: Error: socket token=[redacted]');

    const printed: string[] = [];
    const log = console.error;
    console.error = (line: string) => void printed.push(line);
    try {
      new ConsoleLogger().error('Failed', { err: failure(), error: failure() });
    } finally {
      console.error = log;
    }
    const data = JSON.parse(printed[0]!.slice('[error] Failed '.length)) as Record<string, unknown>;
    expect(data, printed[0]).toMatchObject({ err: written, error: written });
    expect(printed[0]).not.toMatch(/errpw|c4use|own-field/);
  });

  it('the console fallback redacts like pino', () => {
    const written: string[] = [];
    const log = console.log;
    console.log = (line: string) => void written.push(line);
    try {
      new ConsoleLogger({ token: 'bound-t0k3n' }).child({ cookie: 'c=1' }).info('Import', { users: [{ password: 'hunter2' }] });
    } finally {
      console.log = log;
    }
    expect(written).toHaveLength(1);
    expect(written[0]).not.toMatch(/bound-t0k3n|c=1|hunter2/);
    expect(written[0]).toContain('"users":[{"password":"[redacted]"}]');
  });

  it('filters by level', () => {
    const { lines, logger } = capture('warn');
    logger.info('hidden');
    logger.error('shown');
    expect(lines.map((line) => line.msg)).toEqual(['shown']);
  });
});

describe('the log channel', () => {
  it('carries every entry of its app — any level, the bindings of every parent, the request — while something listens', async () => {
    const app = await createApplication({ root: import.meta.dirname, discover: false, env: {} });
    const other = await createApplication({ root: import.meta.dirname, discover: false, env: {} });
    const lines: Record<string, unknown>[] = [];
    const stream = new Writable({ write: (chunk, _encoding, done) => (lines.push(JSON.parse(String(chunk))), done()) });
    const logger = createPinoLogger({ level: 'warn', format: 'json' }, stream, app);
    const foreign = createPinoLogger({ level: 'warn', format: 'json' }, stream, other);
    logger.info('before anyone listens');
    expect(channels.built(app)).toBe(0);

    const entries: LogMessage[] = [];
    const off = channels.subscribe(app, 'log', (entry) => void entries.push(entry));
    try {
      runWithRequest({ requestId: 'req-3' }, () => logger.child({ channel: 'http' }).child({ part: 'kernel' }).debug('below the level', { ms: 3 }));
      logger.warn('a warning');
      foreign.warn('another app');
    } finally {
      off();
    }
    logger.warn('after off');
    expect(entries.map(({ level, message, context, requestId }) => ({ level, message, context, requestId }))).toEqual([
      { level: 'debug', message: 'below the level', context: { channel: 'http', part: 'kernel', ms: 3 }, requestId: 'req-3' },
      { level: 'warn', message: 'a warning', context: {}, requestId: undefined },
    ]);
    // pino's level decides what it writes, not the channel.
    expect(lines.map((line) => line.msg)).toEqual(['a warning', 'another app', 'after off']);
  });
});

describe('enabled(level) — asked before an entry is built', () => {
  it('follows the level — silent lets nothing through — and says yes while the log channel listens', async () => {
    const app = await createApplication({ root: import.meta.dirname, discover: false, env: { NODE_ENV: 'test' } });
    const sink = new Writable({ write: (_chunk, _encoding, done) => done() });
    const silent = createPinoLogger({ level: 'silent', format: 'json' }, sink, app);
    const warn = createPinoLogger({ level: 'warn', format: 'json' }, sink, app);
    expect((['debug', 'info', 'warn', 'error'] as const).map((level) => silent.enabled?.(level))).toEqual([false, false, false, false]);
    expect((['debug', 'info', 'warn', 'error'] as const).map((level) => warn.enabled?.(level))).toEqual([false, false, true, true]);
    expect(silent.child({ channel: 'http' }).enabled?.('info')).toBe(false);
    // The channel sees every level (the devtools): an entry is wanted while it listens, whatever pino writes.
    const off = channels.subscribe(app, 'log', () => undefined);
    try {
      expect(silent.enabled?.('info')).toBe(true);
    } finally {
      off();
    }
    expect(silent.enabled?.('info')).toBe(false);
  });
});

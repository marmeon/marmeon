import { execFileSync, spawn } from 'node:child_process';
import { closeSync, constants, existsSync, openSync, readFileSync, readSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ConsoleLogger, createApplication, LogContextSources, Redactor, redactText } from '@marmeon/core';
import { describeError, runWithJob, runWithRequest, runWithTask } from '@marmeon/core/internal';
import { channels, type LogMessage } from '@marmeon/core/diagnostics';
import pinoPretty from 'pino-pretty';
import { describe, expect, it, onTestFinished } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
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
  return { lines, raw, logger: createPinoLogger({ level, format: 'json' }, { destination: stream }) };
}

describe('@marmeon/log', () => {
  it('does not throw for a getter of the logged data that throws, in a call or a child binding', async () => {
    const app = await createApplication({ root: import.meta.dirname, discover: false }, { env: {} });
    const off = channels.subscribe(app, 'log', () => undefined);
    try {
      const { lines, raw, logger } = capture();
      const withApp = createPinoLogger({ level: 'info', format: 'json' }, { destination: new Writable({ write: (chunk, _e, done) => { raw.push(String(chunk)); lines.push(JSON.parse(String(chunk))); done(); } }), app });
      const thrower = () => { throw new Error('secret=s3cr3t'); };
      const nested = { get x(): number { return thrower(); } };
      const field = Object.defineProperty(new Error('driver'), 'detail', { enumerable: true, get: thrower });
      const top = { get x(): number { return thrower(); } };
      for (const log of [logger, withApp]) {
        expect(() => log.info('Nested', { ctx: nested })).not.toThrow();
        expect(() => log.info('Field', { error: field })).not.toThrow();
        expect(() => log.info('Top', top)).not.toThrow();
        expect(() => log.child({ ctx: nested }).info('Child')).not.toThrow();
      }
      expect(lines).toHaveLength(8);
      for (const line of lines) expect(line.context).toBe('[unserializable]');
      expect(raw.join('')).not.toContain('s3cr3t');
    } finally {
      off();
    }
  });

  it('keeps the request\'s context and the other sources on the line when one source returns data that cannot be read', async () => {
    const app = await createApplication({ root: import.meta.dirname, discover: false }, { env: {} });
    const sources = app.container.make(LogContextSources);
    const offGood = sources.add(() => ({ trace_id: 'abc' }));
    const offBad = sources.add(() => ({ nested: { get x(): number { throw new Error('secret=s3cr3t'); } } }));
    try {
      const { lines, raw } = capture();
      const logger = createPinoLogger({ level: 'info', format: 'json' }, { destination: new Writable({ write: (chunk, _e, done) => { raw.push(String(chunk)); lines.push(JSON.parse(String(chunk))); done(); } }), app });
      runWithRequest({ requestId: 'req-1' }, () => logger.child({ task: 't' }).info('m', { a: 1 }));
      expect(lines[0]).toMatchObject({ requestId: 'req-1', trace_id: 'abc', task: 't', a: 1, context: '[unserializable]' });
      expect(raw.join('')).not.toContain('s3cr3t');
    } finally {
      offGood();
      offBad();
    }
  });

  it('keeps the other keys of an entry when one value has a toJSON that throws — pino replaces just that value', () => {
    const { lines, logger } = capture();
    expect(() => logger.info('m', { a: 1, bad: { toJSON: () => { throw new Error('secret=s3cr3t'); } }, b: 2 })).not.toThrow();
    expect(lines[0]).toMatchObject({ a: 1, b: 2 });
    expect(JSON.stringify(lines[0])).not.toContain('s3cr3t');
  });

  it('takes the stream and the app in its options — the positional form of an untyped caller throws', () => {
    const stream = new Writable({ write: (_chunk, _encoding, done) => done() });
    const untyped = createPinoLogger as unknown as (...args: unknown[]) => unknown;
    expect(() => untyped({ level: 'info', format: 'json' }, stream)).toThrow(TypeError);
    expect(() => untyped({ level: 'info', format: 'json' }, stream)).toThrow('createPinoLogger(config, { destination, app }) takes the stream and the app in its options');
    expect(() => untyped({ level: 'info', format: 'json' }, null)).toThrow('takes the stream and the app in its options');
    expect(() => untyped({ level: 'info', format: 'json' }, {}, undefined)).toThrow(TypeError);
    expect(() => untyped({ level: 'info', format: 'json' }, { destination: stream })).not.toThrow();
  });

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
    const logger = createPinoLogger({ level: 'info', format: 'json', environment: 'staging' }, { destination: stream });
    logger.info('Started');
    logger.child({ channel: 'http' }).warn('Slow');
    expect(lines).toEqual([
      { level: 30, time: expect.any(Number), appEnv: 'staging', msg: 'Started' },
      { level: 40, time: expect.any(Number), appEnv: 'staging', channel: 'http', msg: 'Slow' },
    ]);
  });

  it('writes JSON with the message and context (message first, as `info(msg, ctx)`)', () => {
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
    const app = await createApplication({ root: import.meta.dirname, discover: false }, { env: {} });
    const lines: Record<string, unknown>[] = [];
    const stream = new Writable({
      write(chunk, _encoding, done) {
        lines.push(JSON.parse(String(chunk)));
        done();
      },
    });
    const logger = createPinoLogger({ level: 'info', format: 'json' }, { destination: stream, app });
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

  it('writes a line break in the message or the context as \\n — the console fallback cannot be made to print a line of its own', () => {
    const printed: string[] = [];
    const original = console.log;
    console.log = (line: string) => void printed.push(line);
    try {
      new ConsoleLogger().info('GET /users/7\n[warn] FAKE ERROR\r\u001b[31m\u2028\u202e', { path: 'a\nb', c1: '\u0085x\u2028y' });
    } finally {
      console.log = original;
    }
    expect(printed).toHaveLength(1);
    expect(printed[0]).toBe('[info] GET /users/7\\n[warn] FAKE ERROR\\r\\u001b[31m\\u2028\\u202e {"path":"a\\nb","c1":"\\u0085x\\u2028y"}');
  });

  it('escapes a line break in the message of a pretty logger — it cannot forge a line in the terminal', () => {
    const lines: string[] = [];
    const destination = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const logger = createPinoLogger({ level: 'info', format: 'pretty' }, { destination: pinoPretty({ colorize: false, sync: true, destination }) });
    const failure = new Error('boom\nWARN: forged\u001b[31m');
    logger.error('Failed', { err: failure });
    const text = lines.join('');
    expect(text).not.toContain('\u001b');
    expect(text).not.toMatch(/^WARN: forged/m);
    expect(text).toContain('boom\\nWARN: forged\\u001b[31m');
    expect(text).toMatch(/\n\s+at /);
    lines.length = 0;
    logger.info('GET /users/7\nWARN: Login failed for admin\u001b[31m');
    expect(lines.join('').trimEnd().split('\n')).toHaveLength(1);
    expect(lines.join('')).toContain('GET /users/7\\nWARN: Login failed for admin\\u001b[31m');
  });

  it('escapes every top-level string, key name and child binding of a pretty logger — none forges a line', () => {
    const lines: string[] = [];
    const destination = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const logger = createPinoLogger({ level: 'info', format: 'pretty' }, { destination: pinoPretty({ colorize: false, sync: true, destination }) });
    const forged = 'Ada\n[12:00:00.000] INFO: forged';
    const written = (write: () => void) => {
      lines.length = 0;
      write();
      return lines.join('');
    };
    const outputs = [
      written(() => logger.info('x', { name: forged })),
      written(() => logger.info('x', { caller: forged })),
      written(() => logger.info('x', { note: forged })),
      written(() => logger.info('x', { ['k\n[12:00:00.000] INFO: forged']: 1 })),
      written(() => logger.child({ name: forged }).info('x')),
      written(() => logger.child({ caller: forged }).info('x')),
      written(() => logger.child({ ['k\n[12:00:00.000] INFO: forged']: 1 }).info('x')),
      written(() => logger.child({ a: 1 }).child({ name: forged }).info('x')),
      written(() => logger.child({ a: 1 }).child({ ['k\n[12:00:00.000] INFO: forged']: 1 }).info('x')),
    ];
    for (const text of outputs) {
      expect(text).not.toMatch(/^\s*\[12:00:00\.000\] INFO: forged/m);
      expect(text).toContain('\\n[12:00:00.000] INFO: forged');
    }
  });

  it('writes a child binding named time, level, msg or appEnv as context.<key> — the entry keeps one of each', () => {
    const lines: Record<string, unknown>[] = [];
    const raw: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, done) {
        raw.push(String(chunk));
        lines.push(JSON.parse(String(chunk)));
        done();
      },
    });
    const logger = createPinoLogger({ level: 'info', format: 'json', environment: 'real-env' }, { destination: stream });
    logger.child({ time: 'forged', appEnv: 'forged', level: 'forged', msg: 'forged', task: 'session:prune' }).info('real');
    logger.child({ a: 1 }).child({ time: 'forged' }).info('nested');
    expect(raw[1]!.match(/"time":/g)).toHaveLength(1);
    expect(lines[1]).toMatchObject({ 'context.time': 'forged' });
    for (const key of ['time', 'appEnv', 'level', 'msg']) expect(raw[0]!.match(new RegExp(`"${key}":`, 'g')), key).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 30, msg: 'real', appEnv: 'real-env', task: 'session:prune', 'context.time': 'forged', 'context.appEnv': 'forged', 'context.level': 'forged', 'context.msg': 'forged' });
    expect(lines[0]!.time).not.toBe('forged');
  });

  it('writes a key of the log context once when a child logger is bound with it too (the scheduler’s task)', () => {
    const { lines, raw, logger } = capture();
    runWithTask({ task: 'session:prune' }, () => logger.child({ channel: 'schedule', task: 'session:prune' }).info('Done'));
    runWithTask({ task: 'cache:prune' }, () => logger.child({ channel: 'schedule' }).info('Running'));
    expect(raw[0]!.match(/"task":/g)).toHaveLength(1);
    expect(lines[0]).toMatchObject({ msg: 'Done', channel: 'schedule', task: 'session:prune' });
    expect(lines[1]).toMatchObject({ msg: 'Running', task: 'cache:prune' });
  });

  it('writes a key of a call\'s context that names a field of the framework as context.<key> — logged data forges no level, request id or trace', async () => {
    const forged = { level: 99, time: 1, msg: 'forged', appEnv: 'forged', requestId: 'forged', job: 'forged', jobId: 'forged', attempt: 99, task: 'forged', trace_id: 'forged', span_id: 'forged', trace_flags: 'forged' };
    const app = await createApplication({ root: import.meta.dirname, discover: false }, { env: {} });
    const sources = app.container.make(LogContextSources);
    sources.add(() => ({ trace_id: 'real-trace', span_id: 'real-span', trace_flags: '01' }));
    const lines: Record<string, unknown>[] = [];
    const raw: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, done) {
        raw.push(String(chunk));
        lines.push(JSON.parse(String(chunk)));
        done();
      },
    });
    const logger = createPinoLogger({ level: 'info', format: 'json', environment: 'real-env' }, { destination: stream, app });
    runWithRequest({ requestId: 'real-request' }, () =>
      runWithJob({ job: 'real-job', jobId: 'real-id', attempt: 2 }, () => runWithTask({ task: 'real-task' }, () => logger.info('real message', forged))),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 30, msg: 'real message', appEnv: 'real-env', requestId: 'real-request', job: 'real-job', jobId: 'real-id', attempt: 2, task: 'real-task', trace_id: 'real-trace', span_id: 'real-span', trace_flags: '01' });
    expect(lines[0]!.time).not.toBe(1);
    expect(lines[0]).toMatchObject(Object.fromEntries(Object.entries(forged).map(([key, value]) => [`context.${key}`, value])));
    for (const key of Object.keys(forged)) expect(raw[0]!.match(new RegExp(`"${key}":`, 'g')), key).toHaveLength(1);
  });

  it('writes a forged level or msg once without a request, and a child\'s own task stays task', () => {
    const { lines, raw, logger } = capture();
    logger.info('real', { level: 'fatal', msg: 'forged', requestId: 'forged' });
    logger.child({ task: 'session:prune' }).info('Done', { task: 'forged' });
    expect(raw[0]!.match(/"level":/g)).toHaveLength(1);
    expect(raw[0]!.match(/"msg":/g)).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 30, msg: 'real', 'context.level': 'fatal', 'context.msg': 'forged', 'context.requestId': 'forged' });
    expect(lines[0]).not.toHaveProperty('requestId');
    expect(lines[1]).toMatchObject({ task: 'session:prune', 'context.task': 'forged' });
    expect(raw[1]!.match(/"task":/g)).toHaveLength(1);
  });

  it('lets the bindings of a child logger win over the running scope, and keeps a context.<key> the caller wrote itself', () => {
    const { lines, raw, logger } = capture();
    runWithJob({ job: 'A', jobId: 'a-1', attempt: 1 }, () => logger.child({ job: 'B', jobId: 'b-1' }).info('Held'));
    logger.info('Hook', { 'context.level': 'mine', level: 'forged' });
    expect(lines[0]).toMatchObject({ job: 'B', jobId: 'b-1', attempt: 1 });
    expect(raw[0]!.match(/"job":/g)).toHaveLength(1);
    expect(lines[1]).toMatchObject({ level: 30, 'context.level': 'mine' });
    expect(raw[1]!.match(/"level":/g)).toHaveLength(1);
    expect(raw[1]!.match(/"context\.level":/g)).toHaveLength(1);
  });

  it('leaves a context without a collision as it is', () => {
    const { lines, logger } = capture();
    logger.info('plain', { user: 7, context: 'mine' });
    expect(lines[0]).toMatchObject({ level: 30, msg: 'plain', user: 7, context: 'mine' });
  });

  it('redacts secrets in text — a failed job\'s stored error', () => {
    expect(redactText('login failed: password=hunter2&user=ada, "api_key":"k-1", token: abc123')).toBe(
      'login failed: password=[redacted]&user=ada, "api_key":"[redacted]", token: [redacted]',
    );
    expect(redactText('connect postgres://app:s3cret@db:5432/app and redis://:pw@cache')).toBe('connect postgres://app:***@db:5432/app and redis://:***@cache');
    expect(redactText('Authorization: Bearer eyJhbGciOi.x.y failed; then Bearer abc')).toBe('Authorization: Bearer [redacted] failed; then Bearer [redacted]');
    expect(redactText('GET /reset?signature=f00&expires=1')).toBe('GET /reset?signature=[redacted]&expires=1');
    const error = Object.assign(new Error('SMTP: auth failed for password=x', { cause: new Error('socket token=y') }), { headers: { authorization: 'Basic z' }, code: 'EAUTH' });
    const text = describeError(error, new Redactor());
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
    const app = await createApplication({ root: import.meta.dirname, discover: false }, { env: {} });
    app.container.make(Redactor).addKeys('marmeon_session', 'X-Tenant-Key');
    const raw: string[] = [];
    const stream = new Writable({ write: (chunk, _encoding, done) => (raw.push(String(chunk)), done()) });
    const logger = createPinoLogger({ level: 'info', format: 'json' }, { destination: stream, app });
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

  it('redacts a key the framework renames (msg, time) before it is renamed — a call\'s context and a child\'s bindings', async () => {
    const app = await createApplication({ root: import.meta.dirname, discover: false }, { env: {} });
    app.container.make(Redactor).addKeys('msg', 'time');
    const raw: string[] = [];
    const stream = new Writable({ write: (chunk, _encoding, done) => (raw.push(String(chunk)), done()) });
    const logger = createPinoLogger({ level: 'info', format: 'json' }, { destination: stream, app });
    logger.child({ msg: 'bound-s3cret' }).info('Child');
    logger.info('Call', { time: 'called-s3cret' });
    const all = raw.join('');
    expect(all).not.toMatch(/bound-s3cret|called-s3cret/);
    expect(JSON.parse(raw[0]!)).toMatchObject({ 'context.msg': '[redacted]' });
    expect(JSON.parse(raw[1]!)).toMatchObject({ 'context.time': '[redacted]' });
  });

  it('writes an error under any key with its type, message and stack — masked like under err, never as {}', () => {
    const { lines, raw, logger } = capture();
    const failure = () => Object.assign(new TypeError('import failed for password=errpw', { cause: new Error('socket token=c4use') }), { code: 'EIMPORT', secret: 'own-field' });
    logger.error('Failed', { error: failure(), batch: { last: failure() }, errors: [failure()] });
    const all = raw.join('');
    for (const secret of ['errpw', 'c4use', 'own-field']) expect(all, all).not.toContain(secret);
    const written = { type: 'TypeError', message: expect.stringContaining('import failed for password=[redacted]'), stack: expect.stringContaining('TypeError: import failed'), code: 'EIMPORT', secret: '[redacted]' };
    expect(lines[0], JSON.stringify(lines[0])).toMatchObject({ error: written, batch: { last: written }, errors: [written] });
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
    const app = await createApplication({ root: import.meta.dirname, discover: false }, { env: {} });
    const other = await createApplication({ root: import.meta.dirname, discover: false }, { env: {} });
    const lines: Record<string, unknown>[] = [];
    const stream = new Writable({ write: (chunk, _encoding, done) => (lines.push(JSON.parse(String(chunk))), done()) });
    const logger = createPinoLogger({ level: 'warn', format: 'json' }, { destination: stream, app });
    const foreign = createPinoLogger({ level: 'warn', format: 'json' }, { destination: stream, app: other });
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
    const app = await createApplication({ root: import.meta.dirname, discover: false }, { env: { NODE_ENV: 'test' } });
    const sink = new Writable({ write: (_chunk, _encoding, done) => done() });
    const silent = createPinoLogger({ level: 'silent', format: 'json' }, { destination: sink, app });
    const warn = createPinoLogger({ level: 'warn', format: 'json' }, { destination: sink, app });
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

describe('a log write that fails', () => {
  const index = JSON.stringify(new URL('./index.ts', import.meta.url).href);
  const NOTICE = /^@marmeon\/log: writing to stdout failed \((\w+)\); log lines are dropped until the process restarts\.$/;

  interface Ended {
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly stdout: string;
    readonly stderr: string;
  }

  interface ChildOptions {
    /** `--json` (stdout holds the document; log lines go to stderr). */
    json?: boolean;
    format?: 'json' | 'pretty';
    /** Sees the child's stderr as it comes; `send` writes to its stdin, `kill` ends it, `read` starts reading its stdout. */
    onStderr?: (text: string, tools: { send: (text: string) => void; kill: () => void; read: () => void }) => void;
    /** The reader of its stdout is gone before the child writes: it goes on when told (a line on its stdin). */
    closeStdout?: boolean;
    /** Nobody reads its stdout (a full pipe stays full), unless `onStderr` starts reading with `read()`. */
    stdoutReader?: 'none' | 'later' | 'slow';
  }

  /**
   * Runs `body` (module code with `writeSync`, a `logger` of the format given and `process.stdin` for a signal) in a child that
   * ends itself after 20 s (exit code 9) and is killed when the test ends. `stdio` is the child's descriptors 0 to 2.
   */
  function child(body: string, stdio: readonly [unknown, unknown, unknown], options: ChildOptions = {}): Promise<Ended> {
    const script = `
      setTimeout(() => process.exit(9), 20_000).unref();
      import { writeSync } from 'node:fs';
      import { sendConsoleLogsToStderr } from '@marmeon/core/internal';
      import { createPinoLogger } from ${index};
      ${options.json ? 'sendConsoleLogsToStderr(true);' : ''}
      const logger = createPinoLogger({ level: 'info', format: ${JSON.stringify(options.format ?? 'json')} });
      ${body}
    `;
    const process_ = spawn(process.execPath, ['--conditions=@marmeon/source', '--input-type=module', '-e', script], {
      cwd: import.meta.dirname,
      stdio: stdio as never,
    });
    onTestFinished(() => {
      if (process_.exitCode === null && process_.signalCode === null) process_.kill('SIGKILL');
    });
    let stdout = '';
    let stderr = '';
    let closed = false;
    const read = () =>
      process_.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
        // A slow reader takes one burst, then leaves the pipe full for a while.
        if (options.stdoutReader !== 'slow') return;
        process_.stdout?.pause();
        setTimeout(() => !closed && process_.stdout?.resume(), 300);
      });
    if (options.closeStdout) {
      process_.stdout?.destroy();
      process_.stdin?.end('go');
    } else if (options.stdoutReader === undefined) read();
    process_.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      options.onStderr?.(stderr, {
        send: (input: string) => void process_.stdin?.write(input),
        kill: () => void process_.kill('SIGKILL'),
        read: () => void read(),
      });
    });
    return new Promise((resolve) =>
      process_.on('close', (code, signal) => {
        closed = true;
        resolve({ code, signal, stdout, stderr });
      }),
    );
  }

  /** A read-only descriptor on a file: every write to it fails with EBADF. */
  function readOnlyFd(): number {
    const file = join(tempDir('marmeon-log-'), 'out');
    writeFileSync(file, '');
    const fd = openSync(file, 'r');
    onTestFinished(() => closeSync(fd));
    return fd;
  }

  /** A child's report line (JSON) and the notices among its lines (the notice may come before the report, or after). */
  function split(text: string): { threw: unknown; notices: string[] } {
    const lines = text.trim().split('\n');
    const notices = lines.filter((line) => line.startsWith('@marmeon/log:'));
    return { threw: JSON.parse(lines.filter((line) => !notices.includes(line))[0]!), notices };
  }

  /** What a child reports about its calls: which of them threw. */
  const calls = `
    const threw = [];
    for (const level of ['debug', 'info', 'warn', 'error']) {
      try { logger[level]('line'); } catch (error) { threw.push(error.code ?? String(error)); }
    }
  `;
  const report = (fd: 1 | 2) => `writeSync(${fd}, JSON.stringify({ threw }) + '\\n');`;

  describe('by default (stdout)', () => {
    it('debug, info, warn and error do not throw, the process ends with its own code, one notice names the code', async () => {
      const ended = await child(`${calls} ${report(2)} process.exit(7);`, ['ignore', readOnlyFd(), 'pipe']);
      expect(ended.signal).toBeNull();
      expect(ended.code).toBe(7);
      const { threw, notices } = split(ended.stderr);
      expect(threw).toEqual({ threw: [] });
      expect(notices.map((line) => NOTICE.exec(line)?.[1])).toEqual(['EBADF']);
    }, 30_000);

    it('a failure the process has seen (the notice is out) is not told again by later lines or the exit', async () => {
      const ended = await child(`${calls} await new Promise((resolve) => process.stdin.once('data', resolve)); for (let i = 0; i < 5; i++) logger.info('later'); ${report(2)} process.exit(7);`, ['pipe', readOnlyFd(), 'pipe'], {
        onStderr: (text, { send }) => {
          if (text.includes('dropped until')) send('go');
        },
      });
      expect(ended.signal).toBeNull();
      expect(ended.code).toBe(7);
      const { threw, notices } = split(ended.stderr);
      expect(threw).toEqual({ threw: [] });
      expect(notices.map((line) => NOTICE.exec(line)?.[1])).toEqual(['EBADF']);
    }, 30_000);

    it('nothing throws and the process ends when stderr fails too', async () => {
      const ended = await child(`${calls} process.exit(threw.length === 0 ? 7 : 8);`, ['ignore', readOnlyFd(), readOnlyFd()]);
      expect(ended.signal).toBeNull();
      expect(ended.code).toBe(7);
    }, 30_000);

    it('a stdout that works gets every line, and stderr stays empty', async () => {
      const file = join(tempDir('marmeon-log-'), 'out');
      writeFileSync(file, '');
      const fd = openSync(file, 'w');
      onTestFinished(() => closeSync(fd));
      const ended = await child(`${calls} process.exit(7);`, ['ignore', fd, 'pipe']);
      expect(ended.code).toBe(7);
      expect(readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line).msg)).toEqual(['line', 'line', 'line']);
      expect(ended.stderr).toBe('');
    }, 30_000);

    it('after the failure, a descriptor that takes writes again gets nothing: the destination stays off', async () => {
      // fs.write answers EIO to the first line (a full disk cannot be made here); the destination must not offer it a second.
      const ended = await child(
        `import fs from 'node:fs';
        let attempts = 0;
        fs.write = (...args) => { attempts += 1; args.at(-1)(Object.assign(new Error('EIO'), { code: 'EIO' })); };
        logger.info('first');
        for (let i = 0; i < 5; i++) logger.info('later');
        writeSync(2, JSON.stringify({ threw: attempts }) + '\\n');
        process.exit(7);`,
        ['ignore', 'pipe', 'pipe'],
      );
      expect(ended.code).toBe(7);
      const { threw, notices } = split(ended.stderr);
      expect(threw).toEqual({ threw: 1 });
      expect(notices.map((line) => NOTICE.exec(line)?.[1])).toEqual(['EIO']);
    }, 30_000);

    // `createPinoLogger` for stdout reads `process.stderr` (that opens fd 2 as a stream, which makes a pipe non-blocking), whatever
    // the dependencies load: the child counts the reads of the getter around the call.
    it('the default destination opens stderr as a stream when it is created', async () => {
      const ended = await child(
        `const original = Object.getOwnPropertyDescriptor(process, 'stderr');
        let reads = 0;
        Object.defineProperty(process, 'stderr', { ...original, get() { reads += 1; return original.get.call(process); } });
        try { createPinoLogger({ level: 'info', format: 'json' }); } finally { Object.defineProperty(process, 'stderr', original); }
        writeSync(2, JSON.stringify({ threw: reads }) + '\\n'); process.exit(7);`,
        ['ignore', 'pipe', 'pipe'],
      );
      expect(ended.code).toBe(7);
      expect(split(ended.stderr).threw).toEqual({ threw: 1 });
    }, 30_000);

    // The outcome: with a full stderr pipe the notice is attempted, answered with EAGAIN and dropped, and the process goes on.
    // A named pipe is a pipe to the kernel: the test fills it until a non-blocking descriptor says EAGAIN, and the child gets a
    // blocking open of it.
    it.skipIf(process.platform === 'win32')('the failure notice does not block on a stderr pipe that is full and never read: the process ends with its own code', async () => {
      const dir = tempDir('marmeon-log-');
      const fifo = join(dir, 'stderr');
      execFileSync('mkfifo', [fifo]);
      const childFd = openSync(fifo, constants.O_RDWR);
      const fillFd = openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK);
      onTestFinished(() => {
        closeSync(childFd);
        closeSync(fillFd);
      });
      const chunk = Buffer.alloc(1024, 'x');
      let filled = 0;
      for (;;) {
        try {
          filled += writeSync(fillFd, chunk);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EAGAIN') break;
          throw error;
        }
      }
      const marker = join(dir, 'marker');
      // fs.write answers EIO to the first line, so stdout fails and the notice goes to the full stderr; the child records how that
      // write to fd 2 ended.
      const ended = await child(
        `import fs from 'node:fs';
        import { syncBuiltinESMExports } from 'node:module';
        const realWriteSync = fs.writeSync;
        const notice = [];
        fs.writeSync = (fd, ...rest) => {
          if (fd !== 2) return realWriteSync(fd, ...rest);
          try { return realWriteSync(fd, ...rest); } catch (error) { notice.push(error.code); throw error; }
        };
        syncBuiltinESMExports();
        fs.write = (...args) => { args.at(-1)(Object.assign(new Error('EIO'), { code: 'EIO' })); };
        logger.info('first');
        for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
        fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify(notice));
        process.exit(7);`,
        ['ignore', 'pipe', childFd],
      );
      expect(ended.signal).toBeNull();
      expect(ended.code).toBe(7);
      // The notice write was attempted and answered EAGAIN (a failure path that never ran leaves the list empty).
      expect(existsSync(marker) && JSON.parse(readFileSync(marker, 'utf8'))).toEqual(['EAGAIN']);
      // The pipe holds the filler only: the notice was dropped.
      let held = 0;
      for (;;) {
        try {
          held += readSync(fillFd, Buffer.alloc(4096));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EAGAIN') break;
          throw error;
        }
      }
      expect(held).toBe(filled);
    }, 30_000);

    it('an error without a code (a RangeError from sonic-boom\'s retry recursion) is named by its error name in the notice, never undefined', async () => {
      const ended = await child(
        `import fs from 'node:fs';
        fs.write = (...args) => { args.at(-1)(new RangeError('Maximum call stack size exceeded')); };
        logger.info('first');
        for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
        process.exit(7);`,
        ['ignore', 'pipe', 'pipe'],
      );
      expect(ended.code).toBe(7);
      expect(ended.stderr).not.toContain('undefined');
      expect(ended.stderr.trim().split('\n').map((line) => NOTICE.exec(line)?.[1])).toEqual(['RangeError']);
    }, 30_000);

    it('format pretty: a failed write does not throw, the process ends, one notice', async () => {
      const ended = await child(`${calls} ${report(2)} process.exit(7);`, ['ignore', readOnlyFd(), 'pipe'], { format: 'pretty' });
      expect(ended.signal).toBeNull();
      expect(ended.code).toBe(7);
      const { threw, notices } = split(ended.stderr);
      expect(threw).toEqual({ threw: [] });
      expect(notices.map((line) => NOTICE.exec(line)?.[1])).toEqual(['EBADF']);
    }, 30_000);

    it('format pretty: one entry larger than the asynchronous bound arrives whole', async () => {
      const ended = await child(`logger.info('a'.repeat(5 * 1024 * 1024) + 'END'); process.exit(7);`, ['ignore', 'pipe', 'pipe'], { format: 'pretty' });
      expect(ended.code).toBe(7);
      expect(ended.stdout).toContain('aEND');
      expect(ended.stdout.length).toBeGreaterThan(5 * 1024 * 1024);
    }, 30_000);

    it('a closed pipe (EPIPE) stops the writing without a notice: a reader that left is no error', async () => {
      const ended = await child(
        `await new Promise((resolve) => process.stdin.once('data', resolve)); ${calls} await new Promise((resolve) => setTimeout(resolve, 100)); for (let i = 0; i < 5; i++) logger.info('more'); ${report(2)} process.exitCode = 7;`,
        ['pipe', 'pipe', 'pipe'],
        { closeStdout: true },
      );
      expect(ended.signal).toBeNull();
      expect(ended.code).toBe(7);
      const { threw, notices } = split(ended.stderr);
      expect(threw).toEqual({ threw: [] });
      expect(notices).toEqual([]);
    }, 30_000);
  });

  describe('in --json mode (stderr)', () => {
    it('debug, info, warn and error do not throw, the process ends with its own code, and stdout holds the child\'s own output only', async () => {
      const ended = await child(`${calls} ${report(1)} process.exit(7);`, ['ignore', 'pipe', readOnlyFd()], { json: true });
      expect(ended.signal).toBeNull();
      expect(ended.code).toBe(7);
      expect(JSON.parse(ended.stdout.trim())).toEqual({ threw: [] });
      expect(ended.stdout.trim().split('\n')).toHaveLength(1);
    }, 30_000);

    it('nothing throws and the process ends when stdout fails too', async () => {
      const ended = await child(`${calls} process.exit(threw.length === 0 ? 7 : 8);`, ['ignore', readOnlyFd(), readOnlyFd()], { json: true });
      expect(ended.signal).toBeNull();
      expect(ended.code).toBe(7);
    }, 30_000);

    it('a stderr that works gets every line, and stdout stays empty', async () => {
      const file = join(tempDir('marmeon-log-'), 'out');
      writeFileSync(file, '');
      const fd = openSync(file, 'w');
      onTestFinished(() => closeSync(fd));
      const ended = await child(`${calls} process.exit(7);`, ['ignore', 'pipe', fd], { json: true });
      expect(ended.code).toBe(7);
      expect(readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line).msg)).toEqual(['line', 'line', 'line']);
      expect(ended.stdout).toBe('');
    }, 30_000);

    it('one entry larger than the asynchronous bound still arrives whole: the 4 MiB bound is for the asynchronous destination only', async () => {
      const ended = await child(`logger.info('a'.repeat(5 * 1024 * 1024) + 'END'); process.exit(7);`, ['ignore', 'pipe', 'pipe'], { json: true });
      expect(ended.code).toBe(7);
      const lines = ended.stderr.trim().split('\n');
      expect(lines).toHaveLength(1);
      const msg = JSON.parse(lines[0]!).msg as string;
      expect(msg).toHaveLength(5 * 1024 * 1024 + 3);
      expect(msg.endsWith('aEND')).toBe(true);
    }, 30_000);
  });

  // 3 000 lines of 1 KiB (about 3 MB) are more than a pipe takes and fewer than the destination keeps.
  const flood = `const text = 'x'.repeat(1000); for (let i = 0; i < 3000; i++) logger.info(text);`;

  it('info() returns at once while the pipe is full: the process goes on and reports it', async () => {
    // A call that waited for the pipe would never reach the marker (the child's own 20 s end then ends it, and the test fails).
    let marker = false;
    const ended = await child(`${flood} writeSync(2, 'RETURNED\\n'); setInterval(() => {}, 1000);`, ['ignore', 'pipe', 'pipe'], {
      stdoutReader: 'none',
      onStderr: (text, { kill }) => {
        if (!text.includes('RETURNED')) return;
        marker = true;
        kill();
      },
    });
    expect(marker).toBe(true);
    expect(ended.signal).toBe('SIGKILL');
  }, 30_000);

  it('keeps no more than 4 MiB for a reader that does not read: the rest is dropped, not retained', async () => {
    // 22 000 lines of 1 KiB written without a turn of the event loop: nothing is written before the loop ends, so what reaches the
    // reader is what the destination kept (the child ends after the reader has read everything).
    const ended = await child(`const text = 'x'.repeat(1000); for (let i = 0; i < 22000; i++) logger.info(text); process.exitCode = 7;`, ['ignore', 'pipe', 'pipe']);
    expect(ended.code).toBe(7);
    expect(Buffer.byteLength(ended.stdout)).toBeGreaterThan(1_000_000);
    expect(Buffer.byteLength(ended.stdout)).toBeLessThanOrEqual(4 * 1024 * 1024 + 2_000);
  }, 30_000);

  it('a reader that starts only while the process exits gets every line: the exit waits for the full pipe, and tells nothing', async () => {
    let reading = false;
    const ended = await child(`${flood} writeSync(2, 'EXITING\\n'); process.exit(7);`, ['ignore', 'pipe', 'pipe'], {
      stdoutReader: 'later',
      onStderr: (text, { read }) => {
        if (!text.includes('EXITING') || reading) return;
        reading = true;
        read();
      },
    });
    expect(ended.code).toBe(7);
    expect(ended.stdout.trim().split('\n')).toHaveLength(3000);
    expect(ended.stderr.trim()).toBe('EXITING');
  }, 30_000);

  it('lines of a write that waited for its retry before the exit are not lost: every number arrives once, whole', async () => {
    // Numbered lines of 1 KiB into a pipe that fills; the loop runs for 50 ms (sonic-boom's write meets EAGAIN and waits for its
    // 100 ms retry, nothing is in flight; the 50 ms must stay below that timer), then the process exits and the reader starts.
    let reading = false;
    const ended = await child(
      `for (let i = 0; i < 3000; i++) logger.info(String(i).padStart(5, '0') + 'x'.repeat(1000));
      await new Promise((resolve) => setTimeout(resolve, 50));
      writeSync(2, 'EXITING\\n'); process.exit(7);`,
      ['ignore', 'pipe', 'pipe'],
      {
        stdoutReader: 'later',
        onStderr: (text, { read }) => {
          if (!text.includes('EXITING') || reading) return;
          reading = true;
          read();
        },
      },
    );
    expect(ended.code).toBe(7);
    const numbers = ended.stdout.trim().split('\n').map((line) => Number((JSON.parse(line) as { msg: string }).msg.slice(0, 5)));
    expect(numbers).toEqual(Array.from({ length: 3000 }, (_, i) => i));
    expect(ended.stderr.trim()).toBe('EXITING');
  }, 30_000);

  it('a reader that takes only a small burst now and then does not keep the process from ending: its own code, one notice', async () => {
    let reading = false;
    const ended = await child(`${flood} writeSync(2, 'EXITING\\n'); process.exit(7);`, ['ignore', 'pipe', 'pipe'], {
      stdoutReader: 'slow',
      onStderr: (text, { read }) => {
        if (!text.includes('EXITING') || reading) return;
        reading = true;
        read();
      },
    });
    expect(ended.signal).toBeNull();
    expect(ended.code).toBe(7);
    const notices = ended.stderr.trim().split('\n').filter((line) => line !== 'EXITING');
    expect(notices.map((line) => NOTICE.exec(line)?.[1])).toEqual(['EAGAIN']);
  }, 30_000);

  it('a reader that never reads does not keep the process from ending: it exits with its own code after a bounded wait, with one notice', async () => {
    const ended = await child(`${flood} process.exit(7);`, ['ignore', 'pipe', 'pipe'], { stdoutReader: 'none' });
    expect(ended.signal).toBeNull();
    expect(ended.code).toBe(7);
    expect(ended.stderr.trim().split('\n').map((line) => NOTICE.exec(line)?.[1])).toEqual(['EAGAIN']);
  }, 30_000);

  it('a retry write that sent the chunk before the exit is not written again: every number exactly once', async () => {
    // fs.write answers EAGAIN to the first chunk; sonic-boom's retry (100 ms later) sends it, and the process exits in that write.
    const ended = await child(
      `import fs from 'node:fs';
      const real = fs.write;
      let first = true;
      fs.write = (fd, chunk, ...rest) => {
        if (first) { first = false; return rest.at(-1)(Object.assign(new Error('EAGAIN'), { code: 'EAGAIN' })); }
        real(fd, chunk, (error, n) => { process.exit(7); });
      };
      for (let i = 0; i < 5; i++) logger.info(String(i));`,
      ['ignore', 'pipe', 'pipe'],
    );
    expect(ended.code).toBe(7);
    expect(ended.stdout.trim().split('\n').map((line) => (JSON.parse(line) as { msg: string }).msg)).toEqual(['0', '1', '2', '3', '4']);
  }, 30_000);

  for (const [name, breakIt] of [
    ['_bufs is no array', `sonic._bufs = 'broken';`],
    ['_writing is no boolean', 'sonic._writing = undefined;'],
    ['reading _bufs throws', `Object.defineProperty(sonic, '_bufs', { get() { throw new Error('boom'); }, set() {} });`],
  ] as const) {
    it(`a sonic-boom whose buffers are not the expected ones (${name}): the exit flush drops, tells once and does not throw`, async () => {
      const ended = await child(
        `import { EventEmitter } from 'node:events';
        import { createRequire } from 'node:module';
        // Catches the destination while pino makes it (it registers its listeners on it).
        const sonicPath = createRequire(createRequire(${index}).resolve('pino')).resolve('sonic-boom');
        const SonicBoom = createRequire(import.meta.url)(sonicPath);
        let sonic;
        SonicBoom.prototype.on = function (...args) { sonic = this; return EventEmitter.prototype.on.apply(this, args); };
        const { createPinoLogger: make } = await import(${index} + '?again');
        const again = make({ level: 'info', format: 'json' });
        ${breakIt}
        let threw = null;
        try { sonic.flushSync(); sonic.flushSync(); } catch (error) { threw = String(error); }
        writeSync(2, JSON.stringify({ threw }) + '\\n');
        process.exit(7);`,
        ['ignore', 'pipe', 'pipe'],
      );
      expect(ended.code).toBe(7);
      const { threw, notices } = split(ended.stderr);
      expect(threw).toEqual({ threw: null });
      expect(notices).toEqual(['@marmeon/log: the exit flush to stdout failed; log lines are dropped until the process restarts.']);
    }, 30_000);
  }

  it('a destination passed in is not wrapped: its errors stay the app\'s', () => {
    const logger = createPinoLogger({ level: 'info', format: 'json' }, { destination: { write: () => { throw new Error('the destination failed'); } } as unknown as NodeJS.WritableStream });
    expect(() => logger.info('line')).toThrow('the destination failed');
  });
});

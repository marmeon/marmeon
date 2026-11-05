import { describe, expect, it, vi } from 'vitest';
import { ConsoleLogger, LogContextSources } from './logger.ts';
import { createApplication } from './application.ts';
import { channels } from './channels.ts';
import { Redactor } from './redact.ts';
import { runWithJob, runWithRequest, runWithTask } from './request-context.ts';

describe('ConsoleLogger', () => {
  it('writes a key of a call\'s context that names a field of the framework as context.<key>', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      runWithRequest({ requestId: 'real-request' }, () => new ConsoleLogger().info('Hook', { requestId: 'forged', level: 'fatal', user: 7 }));
      const data = JSON.parse(String(log.mock.calls[0]![0]).replace(/^\[info\] Hook /, '')) as Record<string, unknown>;
      expect(data).toEqual({ requestId: 'real-request', 'context.requestId': 'forged', 'context.level': 'fatal', user: 7 });
    } finally {
      log.mockRestore();
    }
  });

  it('redacts a key the framework renames (level) before it is renamed', async () => {
    const app = await createApplication({ root: import.meta.dirname, discover: false }, { env: {} });
    app.container.make(Redactor).addKeys('level');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      new ConsoleLogger({}, app).info('Hook', { level: 'called-s3cret' });
      expect(String(log.mock.calls[0]![0])).not.toContain('called-s3cret');
    } finally {
      log.mockRestore();
    }
  });

  it('writes a bigint as its digits, also in an error\'s own field and cause', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const logger = new ConsoleLogger();
      logger.info('Plain', { n: 1n });
      logger.info('Own', { error: Object.assign(new Error('driver'), { position: 1n }) });
      logger.info('Cause', { error: new Error('driver', { cause: 1n }) });
      const [plain, own, cause] = log.mock.calls.map((call) => String(call[0]));
      expect(plain).toBe('[info] Plain {"n":"1"}');
      expect(own).toContain('"position":"1"');
      expect(cause).toContain('"cause":"1"');
    } finally {
      log.mockRestore();
    }
  });

  it('writes the entry without its context when the context cannot be serialized', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const broken = { toJSON: () => { throw new Error('nope'); } };
      expect(() => new ConsoleLogger().info('Cleanup', { broken })).not.toThrow();
      expect(String(log.mock.calls[0]![0])).toBe('[info] Cleanup {"context":"[unserializable]"}');
    } finally {
      log.mockRestore();
    }
  });

  it('does not throw for a getter of the logged data that throws, and keeps the bindings on the line', async () => {
    const app = await createApplication({ root: import.meta.dirname, discover: false }, { env: {} });
    const unsubscribe = channels.subscribe(app, 'log', () => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const thrower = () => { throw new Error('secret=s3cr3t'); };
      const nested = { get x(): number { return thrower(); } };
      const field = Object.defineProperty(new Error('driver'), 'detail', { enumerable: true, get: thrower });
      const top = { get x(): number { return thrower(); } };
      const logger = new ConsoleLogger({ task: 'cleanup' }, app);
      expect(() => logger.info('Nested', { ctx: nested })).not.toThrow();
      expect(() => logger.info('Field', { error: field })).not.toThrow();
      expect(() => logger.info('Top', top)).not.toThrow();
      for (const call of log.mock.calls) expect(JSON.parse(String(call[0]).replace(/^\[info\] \w+ /, ''))).toEqual({ task: 'cleanup', context: '[unserializable]' });
      expect(log.mock.calls.join('')).not.toContain('s3cr3t');
      expect(log.mock.calls).toHaveLength(3);
    } finally {
      unsubscribe();
      log.mockRestore();
    }
  });

  it('does not throw for a child bound with data that cannot be read, nor for a source that returns it', async () => {
    const app = await createApplication({ root: import.meta.dirname, discover: false }, { env: {} });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const thrower = () => { throw new Error('secret=s3cr3t'); };
      const logger = new ConsoleLogger({ task: 'cleanup' });
      const bad = [{ ctx: { get x(): number { return thrower(); } } }, { v: { toJSON: thrower } }, { get x(): number { return thrower(); } }];
      for (const bindings of bad) expect(() => logger.child(bindings).info('m')).not.toThrow();
      expect(log.mock.calls.map((call) => String(call[0]))).toEqual(Array(3).fill('[info] m {"task":"cleanup","context":"[unserializable]"}'));
      log.mockClear();
      const sources = app.container.make(LogContextSources);
      for (const returned of [{ get x(): number { return thrower(); } }, { ctx: { get x(): number { return thrower(); } } }]) {
        const off = sources.add(() => returned);
        expect(() => new ConsoleLogger({}, app).info('m')).not.toThrow();
        off();
      }
      expect(log.mock.calls.join('')).not.toContain('s3cr3t');
    } finally {
      log.mockRestore();
    }
  });

  it('keeps the bindings and the request\'s context on the line when one source returns data that cannot be read', async () => {
    const app = await createApplication({ root: import.meta.dirname, discover: false }, { env: {} });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const sources = app.container.make(LogContextSources);
    const offGood = sources.add(() => ({ trace_id: 'abc' }));
    const offBad = sources.add(() => ({ nested: { get x(): number { throw new Error('secret=s3cr3t'); } } }));
    try {
      runWithRequest({ requestId: 'req-1' }, () => new ConsoleLogger({}, app).child({ task: 't' }).info('m'));
      expect(JSON.parse(String(log.mock.calls[0]![0]).replace(/^\[info\] m /, ''))).toEqual({ requestId: 'req-1', trace_id: 'abc', task: 't', context: '[unserializable]' });
      expect(String(log.mock.calls[0]![0])).not.toContain('s3cr3t');
    } finally {
      offGood();
      offBad();
      log.mockRestore();
    }
  });

  it('keeps the task a child logger is bound with', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      runWithTask({ task: 'session:prune' }, () => new ConsoleLogger().child({ task: 'session:prune' }).info('Done'));
      expect(String(log.mock.calls[0]![0])).toBe('[info] Done {"task":"session:prune"}');
    } finally {
      log.mockRestore();
    }
  });

  it('lets the bindings of a child logger win over the running scope, as the JSON logger does', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      runWithJob({ job: 'A', jobId: 'a-1', attempt: 1 }, () => new ConsoleLogger().child({ job: 'B', jobId: 'b-1' }).info('Held'));
      expect(String(log.mock.calls[0]![0])).toBe('[info] Held {"job":"B","jobId":"b-1","attempt":1}');
    } finally {
      log.mockRestore();
    }
  });

  it('keeps a context.<key> the caller wrote itself and drops the value under the framework\'s name', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      new ConsoleLogger().info('Hook', { 'context.level': 'mine', level: 'forged' });
      expect(String(log.mock.calls[0]![0])).toBe('[info] Hook {"context.level":"mine"}');
    } finally {
      log.mockRestore();
    }
  });
});

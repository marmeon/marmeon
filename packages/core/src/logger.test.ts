import { describe, expect, it, vi } from 'vitest';
import { ConsoleLogger } from './logger.ts';
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

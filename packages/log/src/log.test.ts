import { Writable } from 'node:stream';
import { runWithRequest } from '@bespokecore/core';
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

  it('filters by level', () => {
    const { lines, logger } = capture('warn');
    logger.info('hidden');
    logger.error('shown');
    expect(lines.map((line) => line.msg)).toEqual(['shown']);
  });
});

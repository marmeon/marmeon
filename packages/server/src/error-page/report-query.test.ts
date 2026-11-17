import { createApplication, Redactor } from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../../scripts/test/temp-dir.js';
import { buildReport } from './report.ts';

describe('the query of a report', () => {
  it('shows the value of `state` and `code` as [redacted], and the others as they are', async () => {
    const app = await createApplication({ root: tempDir('marmeon-report-query-'), discover: false, providers: [] }, { env: { NODE_ENV: 'development' } });
    const request = new Request('http://localhost/cb?state=abc123&code=c0de&page=2&STATE=upper');
    const report = await buildReport({ error: new Error('x'), status: 500, request, requestId: undefined, app, redactor: new Redactor(), solutions: undefined });
    expect(report.request.query).toEqual({ state: '[redacted]', code: '[redacted]', page: '2', STATE: '[redacted]' });
    expect(report.request.url).toBe('http://localhost/cb?state=[redacted]&code=[redacted]&page=2&STATE=[redacted]');
  });
});

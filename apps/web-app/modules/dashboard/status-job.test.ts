import { CheckStatusBoardJob } from '@fixtures/status-board';
import { JobRegistry } from '@marmeon/queue';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';

// The status board package brings a job on its provider (`static jobs`): no module of the app lists it, and a worker runs it.
let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
});
afterEach(() => app.close());

describe("the package's job", () => {
  it('is listed by no module of the app', () => {
    expect((application.modules ?? []).flatMap((module) => module.jobs ?? [])).not.toContain(CheckStatusBoardJob);
  });

  it('is registered through the provider, and a worker runs one dispatched job without a failure', async () => {
    expect(app.make(JobRegistry).has(CheckStatusBoardJob)).toBe(true);
    await app.queue.dispatch(CheckStatusBoardJob, { service: 'Web' });
    app.queue.assertDispatched(CheckStatusBoardJob, { service: 'Web' });
    const result = await app.queue.work();
    expect(result).toMatchObject({ processed: 1, failed: 0 });
    expect(await app.queue.failed()).toEqual([]);
  });
});

import { HealthChecks } from '@marmeon/core';
import { Connections } from '@marmeon/database';
import { ServerClosing } from '@marmeon/http';
import { createTestApp } from '@marmeon/testing';
import { describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { StorageWritable } from './health/StorageWritable.ts';

describe('health in the web app', () => {
  it('/up answers before the `web` group: no session cookie, no CSRF, no request id — a sign-in beside it gets them', async () => {
    const app = await createTestApp(application, { database: 'refresh', csrf: true });
    const up = await app.get('/up');
    expect(up.status).toBe(200);
    expect(up.body).toBe('OK');
    expect(up.headers.getSetCookie()).toEqual([]);
    expect(up.headers.has('x-request-id')).toBe(false);
    // The control: a request of the `web` group that writes the session (a guest's failed sign-in) sets its cookies.
    const login = await app.post('/login', { form: { email: 'nobody@example.com', password: 'x' }, headers: { 'sec-fetch-site': 'same-origin' } });
    expect(login.headers.getSetCookie().length).toBeGreaterThan(0);
    expect(login.headers.has('x-request-id')).toBe(true);
    await app.close();
  });

  it('/up/ready runs the database, redis, cache, queue and storage checks — the details only with the development error handling', async () => {
    const app = await createTestApp(application, { database: 'refresh', debug: true });
    expect(app.make(HealthChecks).all().map((check) => check.check)).toEqual(['database', 'redis', 'cache', 'queue', 'storage']);
    expect(app.make(HealthChecks).all()).toContain(StorageWritable);
    const ready = await app.get('/up/ready');
    expect(ready.status).toBe(200);
    const body = JSON.parse(ready.body) as { status: string; checks: { name: string; status: string; note?: string }[] };
    expect(body.status).toBe('ok');
    expect(body.checks.map(({ name, status, note }) => ({ name, status, note }))).toEqual([
      { name: 'database', status: 'ok', note: expect.stringContaining('default') },
      { name: 'redis', status: 'ok', note: 'no connection in use' },
      { name: 'cache', status: 'ok', note: expect.any(String) },
      { name: 'queue', status: 'ok', note: expect.stringMatching(/ waiting$/) },
      { name: 'storage', status: 'ok', note: 'local' },
    ]);
    await app.close();

    const plain = await createTestApp(application, { database: 'refresh' });
    const quiet = await plain.get('/up/ready');
    expect(JSON.parse(quiet.body)).toEqual({ status: 'ok' });
    await plain.close();
  });

  it('a dead database: /up/ready 503, /up stays 200 (liveness checks nothing)', async () => {
    const app = await createTestApp(application, { database: 'refresh' });
    await app.make(Connections).destroy();
    const ready = await app.get('/up/ready');
    expect(ready.status).toBe(503);
    expect(JSON.parse(ready.body)).toEqual({ status: 'failing' });
    expect((await app.get('/up')).status).toBe(200);
  });

  it('while the server drains: 503', async () => {
    const app = await createTestApp(application, { database: 'refresh' });
    app.make(ServerClosing).close();
    expect((await app.get('/up')).status).toBe(503);
    expect((await app.get('/up/ready')).status).toBe(503);
    await app.close();
  });
});

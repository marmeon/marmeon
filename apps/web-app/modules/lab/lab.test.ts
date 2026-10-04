import { Logger, type LogContext } from '@bespokecore/core';
import { createTestApp } from '@bespokecore/testing';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import type { SendDevtoolsLabController } from './controllers/ShowDevtoolsLabController.ts';

/** Keeps what the app logs, to look for the SSR errors. */
function recordingLogger(entries: { level: string; message: string; context: LogContext }[], bindings: LogContext = {}): Logger {
  const log = (level: string) => (message: string, context: LogContext = {}) => void entries.push({ level, message, context: { ...bindings, ...context } });
  return { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error'), child: (more) => recordingLogger(entries, { ...bindings, ...more }) };
}

async function lab() {
  const entries: { level: string; message: string; context: LogContext }[] = [];
  const app = await createTestApp(application, { ssr: true, override: (container) => container.instance(Logger, recordingLogger(entries)) });
  return { app, entries };
}

const page = { headers: { accept: 'text/html' } };

describe('the SSR lab (W5 step 7)', () => {
  it('a page that reads `window` while rendering still works: sent without markup for the browser to render, the error logged', async () => {
    const { app, entries } = await lab();
    const response = await app.get('/lab/client-only', page).assertOk();
    expect(response.body).toMatch(/<div id="app"><\/div>/);
    response.assertPage('lab/ClientOnly');
    expect(response.body).not.toContain('Server Error');
    expect(entries).toContainEqual(
      expect.objectContaining({
        level: 'error',
        message: 'Server rendering of [lab/ClientOnly] failed — the browser renders the page',
        context: expect.objectContaining({ exception: 'ReferenceError', message: 'window is not defined' }),
      }),
    );
    // The stack points into the view's source (Vite's ssrFixStacktrace), not into the transformed module.
    const line = readFileSync(new URL('./views/ClientOnly.tsx', import.meta.url), 'utf8').split('\n').findIndex((text) => text.includes('window.innerWidth')) + 1;
    expect(entries.find((entry) => entry.context.exception === 'ReferenceError')?.context.stack).toContain(`modules/lab/views/ClientOnly.tsx:${line}:`);
  });

  it('a page with ssr = false is sent without markup — and nothing is logged', async () => {
    const { app, entries } = await lab();
    const response = await app.get('/lab/browser-only', page).assertOk().assertPage('lab/BrowserOnly');
    expect(response.body).toMatch(/<div id="app"><\/div>/);
    expect(response.body).toContain('<title data-bespoke-head="ssr">BespokeCore</title>');
    expect(entries.filter((entry) => entry.level === 'error')).toEqual([]);
  });

  it('a slow Suspense boundary is in the HTML when the page renders completely (tests and bots)', async () => {
    const { app } = await lab();
    await app.get('/lab/streaming', page).assertOk().assertServerRendered().assertSee('<p data-slow-part="true">Rendered 1000 ms after the shell.</p>').assertDontSee('Loading the slow part');
  }, 10_000);

  it('renders a Date prop as the browser gets it — an ISO string — so the page renders on the server and hydrates (W5.1 finding)', async () => {
    const { app } = await lab();
    const response = await app.get('/lab/streaming', page).assertServerRendered().assertHydrates();
    const { now } = response.page()!.props as { now: string };
    // `now.slice(…)` in the view: a string on the server too (before W5.7 a Date — "now.slice is not a function").
    response.assertSee(`<time dateTime="${now}">${now.slice(11, 19)}</time>`);
  }, 10_000);

  it('an error in a Suspense boundary still delivers the page — the shell, and that part for the browser to render', async () => {
    const { app, entries } = await lab();
    const response = await app.get('/lab/late-error', page).assertOk();
    expect(response.body).toContain('<h1>Late error</h1>');
    expect(response.body).toContain('Loading the late part…'); // the boundary's fallback, until the browser renders it
    expect(response.body).toContain('data-dgst="bespoke:ssr"');
    expect(entries).toContainEqual(expect.objectContaining({ level: 'error', message: 'Server rendering of [lab/LateError] failed in a Suspense boundary — the browser renders that part' }));
  });

  it('is off unless enabled: 404 with LAB_PAGES=false (the default in production)', async () => {
    const app = await createTestApp(application, { env: { LAB_PAGES: 'false' } });
    await app.get('/lab/streaming', page).assertNotFound();
  });
});

describe('the devtools lab (W7 step 9)', () => {
  it('a hydration mismatch on purpose (?mismatch=1): the server renders its own text — the browser renders another (React recovers)', async () => {
    const { app } = await lab();
    await app.get('/lab/devtools?mismatch=1', page).assertOk().assertPage('lab/Devtools').assertSee('Rendered by <!-- -->the server<!-- -->.');
    await app.get('/lab/devtools', page).assertOk().assertDontSee('Rendered by');
  });

  it('the client hooks part renders in the browser (a feature: no navigator on the server) — its form is sent back with errors', async () => {
    const { app } = await lab();
    await app.get('/lab/devtools', page).assertOk().assertServerRendered().assertDontSee('Client hooks');
    await app.post('/lab/devtools', { form: { name: 'x' }, headers: { referer: 'http://localhost/lab/devtools' } }).assertRedirect('/lab/devtools').assertInvalid<SendDevtoolsLabController>({ name: 'At least two characters.' });
  });
});

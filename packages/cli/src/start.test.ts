import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeConditions, writeInjectionArtifacts, writeManifest } from '@marmeon/core/internal';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { bin, greeter, repo } from './__fixtures__/cli.js';

/**
 * `marmeon start`: one Node process — the server itself, no launcher in front, so a supervisor's SIGTERM reaches
 * it — and the `NODE_ENV` it is given (a missing one becomes production; one that is none of development, test, production does not
 * start), with `APP_ENV` naming the environment (a staging server: `NODE_ENV=production APP_ENV=staging`). An app of its own
 * that resolves the framework's built `dist/` like an installed one (`start` never uses the source condition).
 */
describe('marmeon start', { timeout: 30_000 }, () => {
  let app: string;
  const key = `base64:${Buffer.alloc(32, 3).toString('base64')}`;

  beforeAll(() => {
    app = realpathSync(mkdtempSync(join(tmpdir(), 'marmeon-start-')));
    const packages = ['core', 'encryption', 'http', 'router', 'server', 'log'];
    writeFileSync(join(app, 'package.json'), JSON.stringify({ type: 'module', dependencies: Object.fromEntries(packages.map((name) => [`@marmeon/${name}`, '*'])) }));
    for (const name of packages) {
      mkdirSync(join(app, 'node_modules/@marmeon'), { recursive: true });
      symlinkSync(join(repo, 'packages', name), join(app, 'node_modules/@marmeon', name), 'dir');
    }
    // For the SSR bundle of the staging probe (not discovered: no dependency) — React resolves from the package's own folder.
    symlinkSync(join(repo, 'packages/react'), join(app, 'node_modules/@marmeon/react'), 'dir');
    mkdirSync(join(app, 'bootstrap'));
    mkdirSync(join(app, 'services'));
    // A class built by the container at boot: what it was injected with is in the output.
    writeFileSync(join(app, 'services/Greeter.ts'), greeter(['clock: Clock']));
    writeFileSync(
      join(app, 'bootstrap/app.ts'),
      [
        "import { join } from 'node:path';",
        "import { setTimeout as sleep } from 'node:timers/promises';",
        "import { defineApplication, defineModule, Logger, type Application } from '@marmeon/core';",
        "import { defineRoutes, everyone, view } from '@marmeon/http';",
        "import { Greeter } from '../services/Greeter.ts';",
        '// The logger as a service takes it while the app boots — its warnings later on are said.',
        'let bootLogger: Logger | undefined;',
        'class GreeterProvider {',
        '  boot(app: Application) {',
        "    if (process.env.GREETER_FAILS === '1' && process.env.MARMEON_CLUSTER_WORKER === '1') throw new Error('the greeter cannot boot in a worker');",
        '    console.log(`greeter: ${app.container.make(Greeter).describe()}`);',
        '    bootLogger = app.container.make(Logger);',
        '  }',
        '}',
        '// A request that takes a while — in flight when SIGTERM comes, it must still be answered.',
        '// A library loaded after the server listens — Rolldown, when Vite 8\'s dev server starts — with signal-exit: it re-raises a signal',
        '// when it finds itself the only listener.',
        'function loadSignalExit() {',
        "  for (const signal of ['SIGINT', 'SIGTERM'] as const) {",
        '    const listener = () => {',
        '      if (process.listeners(signal).length === 1) {',
        '        process.removeListener(signal, listener);',
        '        process.kill(process.pid, signal);',
        '      }',
        '    };',
        '    process.on(signal, listener);',
        '  }',
        '}',
        "const slow = defineModule({ name: 'slow', apiRoutes: defineRoutes((Root) => { const Route = Root.authorize(everyone); Route.get('/slow', async () => { await sleep(600); return { pid: process.pid }; }); Route.get('/warn', () => { bootLogger?.warn('warned at runtime'); return { pid: process.pid }; }); Route.get('/signal-exit', () => { loadSignalExit(); return { pid: process.pid }; }); }) });",
        "// A page whose Suspense boundary fails after the shell (the staging probe's /lab/late-error).",
        "const late = defineModule({ name: 'late', routes: defineRoutes((Root) => { const Route = Root.authorize(everyone); Route.get('/late-error', () => view('lab/LateError', {})); }) });",
        "export default defineApplication({ root: join(import.meta.dirname, '..'), providers: [GreeterProvider], modules: [slow, late] });",
        '',
      ].join('\n'),
    );
    // Which modules the start loaded — written when it exits.
    writeFileSync(
      join(app, 'loads.mjs'),
      "import { registerHooks } from 'node:module';\nimport { writeFileSync } from 'node:fs';\nconst urls = [];\nregisterHooks({ load(url, context, next) { urls.push(url); return next(url, context); } });\nprocess.on('exit', () => writeFileSync(new URL('./loaded.json', import.meta.url), JSON.stringify(urls)));\n",
    );
    // What `marmeon build` leaves for the production renderer.
    mkdirSync(join(app, 'dist/client'), { recursive: true });
    mkdirSync(join(app, 'dist/server'), { recursive: true });
    writeFileSync(join(app, 'dist/client/index.html'), '<!doctype html><html><head></head><body><div id="app"></div></body></html>\n');
    writeFileSync(join(app, 'dist/server/ssr.js'), "export const render = async () => ({ html: '' });\n");
  });
  afterAll(() => rmSync(app, { recursive: true, force: true }));

  /**
   * `marmeon start` until `servers` servers listen, on the address the requests go to: `HOST=127.0.0.1`. On every interface
   * (`::`) macOS lets the server — even with the port the system picked for it (`PORT=0`) — listen beside another program
   * that holds the same port on 127.0.0.1 only; a request to 127.0.0.1 then reaches that
   * program (a 404, a 501 from `/up`). Bound to 127.0.0.1 the start fails instead (EADDRINUSE). The requests go to `base`: that address and the
   * port the start line names.
   */
  async function start(env: Record<string, string>, args: string[] = [], servers = 1) {
    const { MARMEON_CHILD: _child, NODE_ENV: _env, NODE_OPTIONS: _options, ...parent } = process.env;
    const child = spawn(process.execPath, [bin, 'start', ...args], { cwd: app, env: { ...parent, APP_KEY: key, HOST: '127.0.0.1', PORT: '0', LOG_LEVEL: 'info', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    const ports = () => [...output.matchAll(/ on http:\/\/[^\s/]+:(\d+) /g)].map((match) => Number(match[1]));
    const deadline = Date.now() + 20_000;
    while (ports().length < servers) {
      if (child.exitCode !== null || Date.now() > deadline) {
        // A start that took too long must not outlive the test (a primary and its workers would keep running).
        child.kill('SIGTERM');
        throw new Error(`marmeon start did not start:\n${output}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    // The workers of a cluster share the one port the primary got.
    expect(new Set(ports()).size).toBe(1);
    const port = ports()[0]!;
    return { child, port, base: `http://127.0.0.1:${port}`, exited, output: () => output };
  }

  it('is one process, runs a staging server as production named by APP_ENV — JSON logs with appEnv — and drains on SIGTERM', async () => {
    const server = await start({ NODE_ENV: 'production', APP_ENV: 'staging' });
    try {
      // No launcher, no child: the process that was started is the server.
      expect(spawnSync('pgrep', ['-P', String(server.child.pid)], { encoding: 'utf8' }).stdout).toBe('');
      expect((await fetch(`${server.base}/up`)).status).toBe(200);
      const line = server.output().split('\n').find((entry) => entry.includes('Marmeon in'))!;
      expect(JSON.parse(line).msg).toMatch(new RegExp(`^Marmeon in production \\(APP_ENV=staging\\) on http://localhost:${server.port} \\(the build; `));
      expect(JSON.parse(line).appEnv, 'the JSON log entry names the environment').toBe('staging');
    } finally {
      server.child.kill('SIGTERM');
    }
    expect(await server.exited).toBe(0);
    expect(server.output()).toContain('SIGTERM received, shutting down');
  }, 30_000);

  it('a library that re-raises a signal it is alone with (signal-exit, under Vite 8) does not end the server before its shutdown', async () => {
    const server = await start({ NODE_ENV: 'production' });
    try {
      expect((await fetch(`${server.base}/api/signal-exit`)).status).toBe(200);
    } finally {
      server.child.kill('SIGTERM');
    }
    // Not ended by the signal (exit code null) without "shutting down" — `marmeon dev` would leave its worker and scheduler.
    expect(await server.exited, server.output()).toBe(0);
    expect(server.output()).toContain('SIGTERM received, shutting down');
  }, 30_000);

  it('a SIGTERM while the server starts is answered once it listens: drained, exit 0 — not the end of the process', async () => {
    // The SSR bundle loads while startServer() runs, before the server listens: a supervisor's SIGTERM lands in that window.
    const ssr = join(app, 'dist/server/ssr.js');
    const original = readFileSync(ssr, 'utf8');
    writeFileSync(ssr, "console.log('ssr: loading');\nawait new Promise((resolve) => setTimeout(resolve, 800));\nexport const render = async () => ({ html: '' });\n");
    try {
      const { MARMEON_CHILD: _child, NODE_ENV: _env, NODE_OPTIONS: _options, ...parent } = process.env;
      const child = spawn(process.execPath, [bin, 'start'], { cwd: app, env: { ...parent, APP_KEY: key, HOST: '127.0.0.1', PORT: '0', LOG_LEVEL: 'info', NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (chunk) => (output += chunk));
      child.stderr.on('data', (chunk) => (output += chunk));
      const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
      const deadline = Date.now() + 20_000;
      while (!output.includes('ssr: loading')) {
        if (child.exitCode !== null || Date.now() > deadline) throw new Error(`marmeon start did not load the SSR bundle:\n${output}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      child.kill('SIGTERM');
      expect(await exited).toEqual({ code: 0, signal: null });
      expect(output).toMatch(/ on http:\/\/localhost:\d+ /);
      expect(output).toContain('SIGTERM received, shutting down');
    } finally {
      writeFileSync(ssr, original);
    }
  }, 30_000);

  it('--workers=2: a primary and two servers on one port; SIGTERM reaches both, each drains its request, exit 0', async () => {
    // Without the build's injection lists every process boots with a warning — said once, by the primary, not by each worker.
    rmSync(join(app, '.marmeon/injections.json'), { force: true });
    const server = await start({ NODE_ENV: 'production' }, ['--workers=2'], 2);
    let slow: Promise<Response> | undefined;
    try {
      // The primary forked two workers (node:cluster) — no launcher, no other process.
      const workers = spawnSync('pgrep', ['-P', String(server.child.pid)], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
      expect(workers).toHaveLength(2);
      expect((await fetch(`${server.base}/up`)).status).toBe(200);
      // A worker's warnings after its boot are said (its boot's were not: the primary said them).
      expect((await fetch(`${server.base}/api/warn`)).status).toBe(200);
      // A request in flight in each worker (round-robin), then SIGTERM to the primary only — as `docker stop` sends it.
      slow = Promise.all([fetch(`${server.base}/api/slow`), fetch(`${server.base}/api/slow`)]).then(([a]) => a);
      await new Promise((resolve) => setTimeout(resolve, 150));
    } finally {
      server.child.kill('SIGTERM');
    }
    expect((await slow!).status).toBe(200);
    expect(await server.exited).toBe(0);
    const output = server.output();
    expect(output).toContain('Starting 2 workers (node:cluster, primary');
    expect(output).toContain('SIGTERM received, stopping 2 workers');
    // Each worker drained as one server does.
    expect(output.split('SIGTERM received, shutting down').length - 1).toBe(2);
    expect(output).not.toContain('ended with');
    expect(output.split('Build artifacts are missing').length - 1).toBe(1);
    expect(output.split('warned at runtime').length - 1).toBe(1);
  }, 30_000);

  it('a program on 127.0.0.1 at the server\'s port: the start fails (EADDRINUSE) — never a server beside it that the requests miss', async () => {
    // On every interface the server could start beside a program holding its port on 127.0.0.1, and `/up` would reach that
    // program (501). The helper binds the address it asks.
    const program = createHttpServer((_request, response) => {
      response.statusCode = 501;
      response.end();
    });
    await new Promise<void>((resolve) => program.listen(0, '127.0.0.1', resolve));
    const port = (program.address() as AddressInfo).port;
    try {
      const outcome = await start({ NODE_ENV: 'production', PORT: String(port) }).then(
        async (server) => {
          const status = (await fetch(`${server.base}/up`)).status;
          server.child.kill('SIGTERM');
          await server.exited;
          return `started beside the program on 127.0.0.1:${port} — ${server.base}/up answered ${status}`;
        },
        (error: Error) => error.message,
      );
      expect(outcome).toContain('EADDRINUSE');
    } finally {
      program.close();
    }
  }, 30_000);

  it('the workers\' mark left in the environment silences no single server: its boot warnings are said', async () => {
    rmSync(join(app, '.marmeon/injections.json'), { force: true });
    const server = await start({ NODE_ENV: 'production', MARMEON_CLUSTER_WORKER: '1' });
    server.child.kill('SIGTERM');
    expect(await server.exited).toBe(0);
    expect(server.output()).toContain('Build artifacts are missing');
  }, 30_000);

  it('a worker that cannot start stops the cluster with its exit code; --workers needs a number', async () => {
    const { MARMEON_CHILD: _child, NODE_ENV: _env, NODE_OPTIONS: _options, ...parent } = process.env;
    // A cluster that hangs (the bug this test is for) must not outlive the test: each runs in a process group of its own, killed
    // whole when the test ends — also after a timeout, when the awaits below never return.
    const groups: number[] = [];
    onTestFinished(() => {
      for (const pid of groups) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // ended already, workers and all
        }
      }
    });
    // The port is taken: every worker fails to listen — the cluster must end, not fork them forever.
    const busy = createServer();
    await new Promise<void>((resolve) => busy.listen(0, '127.0.0.1', resolve));
    try {
      const port = (busy.address() as AddressInfo).port;
      const failed = await new Promise<{ code: number | null; output: string }>((resolve) => {
        const child = spawn(process.execPath, [bin, 'start', '--workers=2'], { cwd: app, detached: true, env: { ...parent, APP_KEY: key, HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'production' } });
        groups.push(child.pid!);
        let output = '';
        child.stdout.on('data', (chunk) => (output += chunk));
        child.stderr.on('data', (chunk) => (output += chunk));
        const timer = setTimeout(() => child.kill('SIGKILL'), 12_000);
        child.once('exit', (code) => (clearTimeout(timer), resolve({ code, output })));
      });
      expect(failed.output).toContain('ended before it listened');
      expect(failed.code).not.toBe(0);
    } finally {
      busy.close();
    }
    // A worker whose app fails to boot (a provider throws — LIVE_DRIVER=memory with --workers): it ends, and so does
    // the cluster — it neither hangs on its channel to the primary nor forks again.
    const booting = await new Promise<{ code: number | null; output: string }>((resolve) => {
      const child = spawn(process.execPath, [bin, 'start', '--workers=2'], { cwd: app, detached: true, env: { ...parent, APP_KEY: key, HOST: '127.0.0.1', PORT: '0', NODE_ENV: 'production', GREETER_FAILS: '1' } });
      groups.push(child.pid!);
      let output = '';
      child.stdout.on('data', (chunk) => (output += chunk));
      child.stderr.on('data', (chunk) => (output += chunk));
      const timer = setTimeout(() => child.kill('SIGKILL'), 12_000);
      child.once('exit', (code) => (clearTimeout(timer), resolve({ code, output })));
    });
    expect(booting.output).toContain('the greeter cannot boot in a worker');
    expect(booting.output).toMatch(/ended before it listened \(code 1\)/);
    expect(booting.code).toBe(1);
    const wrong = spawnSync(process.execPath, [bin, 'start', '--workers=0'], { cwd: app, encoding: 'utf8', timeout: 20_000, env: { ...parent, APP_KEY: key, NODE_ENV: 'production' } });
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toContain('--workers expects a number of processes from 1, like --workers=4 (got 0).');
  }, 30_000);

  it('SERVER_SHUTDOWN_DELAY_SECONDS=1: after SIGTERM /up/ready 503 and requests answered for a second, then the drain; SIGINT skips it', async () => {
    const server = await start({ NODE_ENV: 'production', SERVER_SHUTDOWN_DELAY_SECONDS: '1' });
    const base = server.base;
    const signalled = performance.now();
    server.child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await fetch(`${base}/up/ready`)).status).toBe(503);
    expect((await fetch(`${base}/up`)).status).toBe(200);
    expect((await fetch(`${base}/api/slow`)).status).toBe(200);
    expect(await server.exited).toBe(0);
    expect(performance.now() - signalled).toBeGreaterThanOrEqual(1000);
    expect(server.output()).toContain('SIGTERM received, shutting down — not ready any more, still answering for 1 s (SERVER_SHUTDOWN_DELAY_SECONDS)');

    const interrupted = await start({ NODE_ENV: 'production', SERVER_SHUTDOWN_DELAY_SECONDS: '5' });
    const stopped = performance.now();
    interrupted.child.kill('SIGINT');
    expect(await interrupted.exited).toBe(0);
    expect(performance.now() - stopped).toBeLessThan(3000);
  }, 30_000);

  it('refuses to start when NODE_ENV=development or test comes from .env only — nothing of the app runs', () => {
    const { MARMEON_CHILD: _child, NODE_ENV: _env, NODE_OPTIONS: _options, ...parent } = process.env;
    const run = (command = 'start') => spawnSync(process.execPath, [bin, command], { cwd: app, encoding: 'utf8', timeout: 20_000, env: { ...parent, APP_KEY: key, PORT: '0', LOG_LEVEL: 'info' } });
    for (const [name, command] of [['development', 'start'], ['test', 'start'], ['development', 'serve']] as const) {
      writeFileSync(join(app, '.env'), `NODE_ENV=${name}\n`);
      try {
        const result = run(command);
        expect(result.status, `${command} ${name}`).toBe(1);
        expect(result.stderr).toContain(`✗ marmeon ${command} runs in production. NODE_ENV=${name} comes from .env only`);
        expect(result.stderr).toContain('set NODE_ENV=production to try the build');
        if (name === 'development') expect(result.stderr).toContain('run `marmeon dev`');
        expect(result.stdout, 'nothing of the app ran').toBe('');
        expect(result.stderr).not.toContain(' on http://');
      } finally {
        rmSync(join(app, '.env'));
      }
    }
  }, 30_000);

  it('NODE_ENV=development in the process environment starts the development stack on purpose — .env or not', () => {
    writeFileSync(join(app, '.env'), 'NODE_ENV=development\n');
    mkdirSync(join(app, 'modules')); // what development watches for new views
    try {
      const { MARMEON_CHILD: _child, NODE_ENV: _env, NODE_OPTIONS: _options, ...parent } = process.env;
      // Development serves through Vite's dev server, which this app does not have: its error shows the stack that started.
      const result = spawnSync(process.execPath, [bin, 'start'], { cwd: app, encoding: 'utf8', timeout: 20_000, env: { ...parent, APP_KEY: key, PORT: '0', LOG_LEVEL: 'info', NODE_ENV: 'development' } });
      expect(result.stderr).toContain('Vite is not installed in this app.');
      expect(result.stderr).not.toContain('marmeon start runs in production');
      expect(result.status).toBe(1);
    } finally {
      rmSync(join(app, 'modules'), { recursive: true });
      rmSync(join(app, '.env'));
    }
  }, 30_000);

  it('a .env without NODE_ENV, or with NODE_ENV=production, starts as production', async () => {
    for (const line of ['APP_ENV=staging\n', 'NODE_ENV=production\n']) {
      writeFileSync(join(app, '.env'), line);
      try {
        const server = await start({});
        server.child.kill('SIGTERM');
        expect(await server.exited).toBe(0);
        expect(server.output()).toContain('Marmeon in production (');
      } finally {
        rmSync(join(app, '.env'));
      }
    }
  }, 30_000);

  it('the process NODE_ENV wins over .env — production stays production, no warning; APP_ENV of .env names it', async () => {
    writeFileSync(join(app, '.env'), 'NODE_ENV=development\nAPP_ENV=staging\n');
    try {
      const server = await start({ NODE_ENV: 'production' });
      server.child.kill('SIGTERM');
      expect(await server.exited).toBe(0);
      expect(server.output()).toContain(`Marmeon in production (APP_ENV=staging) on http://localhost:${server.port}`);
      expect(server.output()).not.toContain('comes from .env');
    } finally {
      rmSync(join(app, '.env'));
    }
  }, 30_000);

  it('runs as production when NODE_ENV is missing', async () => {
    const server = await start({});
    server.child.kill('SIGTERM');
    expect(await server.exited).toBe(0);
    expect(server.output()).toContain('Marmeon in production (APP_ENV=production) on http://localhost:');
  }, 30_000);

  it('does not start with any other NODE_ENV — the start error names the way: NODE_ENV=production and APP_ENV', () => {
    const { MARMEON_CHILD: _child, NODE_ENV: _env, NODE_OPTIONS: _options, ...parent } = process.env;
    const run = (env: Record<string, string>) =>
      spawnSync(process.execPath, [bin, 'start'], { cwd: app, encoding: 'utf8', timeout: 20_000, env: { ...parent, APP_KEY: key, HOST: '127.0.0.1', PORT: '0', ...env } });
    const staging = run({ NODE_ENV: 'staging' });
    expect(staging.status).toBe(1);
    expect(staging.stdout, 'nothing of the app ran').toBe('');
    expect(staging.stderr).toContain('NODE_ENV=staging is not an environment Node knows — set NODE_ENV=production and APP_ENV=staging.');
    expect(staging.stderr).not.toContain(' on http://');
    // From .env just the same — said so.
    writeFileSync(join(app, '.env'), 'NODE_ENV=staging\n');
    try {
      const fromDotEnv = run({});
      expect(fromDotEnv.status).toBe(1);
      expect(fromDotEnv.stderr).toContain('NODE_ENV=staging (in .env) is not an environment Node knows');
    } finally {
      rmSync(join(app, '.env'));
    }
  }, 30_000);

  it('a staging server (NODE_ENV=production APP_ENV=staging) streams a late server-rendering error as its digest only — no message, no stack', async () => {
    // A real SSR bundle: React's server renderer, chosen by the process's NODE_ENV when it loads — the page's boundary fails after the shell.
    const ssr = join(app, 'dist/server/ssr.js');
    const template = join(app, 'dist/client/index.html');
    const originals = { ssr: readFileSync(ssr, 'utf8'), template: readFileSync(template, 'utf8') };
    writeFileSync(template, '<!doctype html><html><head></head><body><div id="app"><!--app-html--></div></body></html>\n');
    writeFileSync(
      ssr,
      [
        "import { createRequire } from 'node:module';",
        "import { createSsrRenderer } from '@marmeon/react/server';",
        "const { createElement, Suspense, use } = createRequire(import.meta.resolve('@marmeon/react/server'))('react');",
        'function LatePart({ failing }) {',
        '  use(failing);',
        '  return null;',
        '}',
        'function LateError() {',
        "  const failing = new Promise((_, reject) => setTimeout(() => reject(new Error('SECRET-MESSAGE of the late part')), 30));",
        "  return createElement('main', null, createElement('h1', null, 'Late error'), createElement(Suspense, { fallback: createElement('p', null, 'Loading the late part…') }, createElement(LatePart, { failing })));",
        '}',
        'export const render = createSsrRenderer(async () => LateError);',
        '',
      ].join('\n'),
    );
    try {
      const server = await start({ NODE_ENV: 'production', APP_ENV: 'staging' });
      try {
        expect(server.output()).toContain(`Marmeon in production (APP_ENV=staging) on http://localhost:${server.port}`);
        const response = await fetch(`${server.base}/late-error`, { headers: { accept: 'text/html' } });
        const html = await response.text();
        expect(response.status, server.output()).toBe(200);
        expect(html).toContain('<h1>Late error</h1>');
        // The boundary goes to the browser with the framework's digest — React's production build sends nothing else (its
        // development build, which any NODE_ENV but production loads, adds the message and the stack).
        for (const leak of ['SECRET-MESSAGE', 'at LatePart', 'ssr.js:']) expect(html, `the stream leaks ${leak}`).not.toContain(leak);
        expect(html).toContain('$RX("B:0","marmeon:ssr")');
        // The error itself goes to the log, not to the visitor.
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(server.output()).toContain('failed in a Suspense boundary');
      } finally {
        server.child.kill('SIGTERM');
      }
      expect(await server.exited).toBe(0);
    } finally {
      writeFileSync(ssr, originals.ssr);
      writeFileSync(template, originals.template);
    }
  }, 30_000);

  /** One start until it listens, then SIGTERM: its output and the modules it loaded. */
  async function startOnce(env: Record<string, string> = {}) {
    rmSync(join(app, 'loaded.json'), { force: true });
    const server = await start({ NODE_OPTIONS: `--import=${join(app, 'loads.mjs')}`, ...env });
    server.child.kill('SIGTERM');
    expect(await server.exited).toBe(0);
    const loaded = JSON.parse(readFileSync(join(app, 'loaded.json'), 'utf8')) as string[];
    return { output: server.output(), loaded: (name: string) => loaded.some((url) => url.includes(`/node_modules/${name}/`) || url.includes(`/${name}@`)) };
  }

  it('applies the injection lists of marmeon build: no oxc-parser, no pino-pretty for JSON logs, and a compile cache', async () => {
    rmSync(join(app, 'storage'), { recursive: true, force: true });
    // What `marmeon build` leaves: the injection lists and the discovery manifest (discovering would parse .d.ts files with oxc).
    writeInjectionArtifacts({ root: app });
    writeManifest({ root: app, conditions: runtimeConditions([], '') });
    const { output, loaded } = await startOnce();
    expect(output).toContain('greeter: SystemClock');
    expect(output).not.toContain('Build artifacts');
    expect(loaded('oxc-parser')).toBe(false);
    expect(loaded('pino-pretty')).toBe(false);
    // Node's compile cache, written once the server listens.
    const cache = join(app, 'storage/framework/compile-cache');
    expect(readdirSync(cache).flatMap((version) => readdirSync(join(cache, version))).length).toBeGreaterThan(50);
  }, 30_000);

  it('derives the lists of a module changed after the build — on every start, with the compile cache warm — and says so once', async () => {
    writeInjectionArtifacts({ root: app });
    await startOnce(); // warms the compile cache with the module as built
    writeFileSync(join(app, 'services/Greeter.ts'), greeter(['clock: Clock', 'redactor: Redactor']));
    try {
      for (let run = 0; run < 2; run++) {
        const { output, loaded } = await startOnce();
        expect(output).toContain('greeter: SystemClock+Redactor');
        expect(output.split('Build artifacts are stale (1 file: services/Greeter.ts)').length - 1).toBe(1);
        expect(loaded('oxc-parser')).toBe(true);
      }
    } finally {
      writeFileSync(join(app, 'services/Greeter.ts'), greeter(['clock: Clock']));
    }
  }, 60_000);

  it('analyses what marmeon build never saw — a missing file, a module not in it — instead of failing', async () => {
    rmSync(join(app, '.marmeon/injections.json'), { force: true });
    const { output } = await startOnce();
    expect(output).toContain('greeter: SystemClock');
    expect(output).toContain('Build artifacts are missing (.marmeon/injections.json): the injection lists of 1 file (services/Greeter.ts)');
  }, 30_000);

  it('starts without the compile cache when its directory cannot be written', async () => {
    rmSync(join(app, 'storage'), { recursive: true, force: true });
    mkdirSync(join(app, 'storage'));
    chmodSync(join(app, 'storage'), 0o555);
    try {
      const { output } = await startOnce();
      expect(output).toContain('greeter: SystemClock');
      expect(existsSync(join(app, 'storage/framework'))).toBe(false);
    } finally {
      chmodSync(join(app, 'storage'), 0o755);
    }
  }, 30_000);
});

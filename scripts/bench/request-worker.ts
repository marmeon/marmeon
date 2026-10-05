/**
 * One measured process of `pnpm bench login|people` (see `requests.ts`): boots the web app of the checkout `argv[2]` in-process —
 * `createTestApp` of that checkout, SQLite in memory and seeded, `SESSION_DRIVER=memory` as its `.env.test` says — and sends the
 * scenarios' requests one after the other through the kernel, as the tests do. The checkout may be an older commit (a base in a
 * `git worktree`): this file only uses what every checkout since Wave 7 has.
 *
 * Started by `requests.ts` with the cwd `<checkout>/apps/web-app`, `NODE_ENV=test`, the source condition and the checkout's injection
 * hook. Environment: `BENCH_SCENARIOS` (comma-separated), `BENCH_ROUNDS` (rounds per scenario, the median counts), `BENCH_REQUESTS`
 * (per round), `BENCH_ENCRYPT` (`SESSION_ENCRYPT`, default false), `BENCH_WITHOUT` (measures switched off — `shims.ts` does the
 * rest), `BENCH_CHECK` (1: one CSRF-protected POST first, for the counters), `BENCH_PROFILE` (a file: a CPU profile of the measured
 * rounds only, through the inspector). Prints one JSON line.
 */
import { writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SCENARIOS = {
  /** E154's `/login`: a JSON visit of `GET /login` with a guest session (a failed sign-in made it) — read, written back, CSRF token. */
  login: 'JSON visit of GET /login with a guest session',
  /** `GET /login` without a cookie: since Wave 8 step 6 no session at all. */
  'login-guest': 'JSON visit of GET /login without a cookie (no session since W8 step 6)',
  /** The document (HTML, server-rendered) of `GET /login` with a guest session — where the CSP nonce is made. */
  'login-document': 'document GET /login with a guest session (HTML: CSP nonce)',
  /** A signed-in page: session, auth, queries, shared props. */
  people: 'JSON visit of GET /people signed in',
} as const;
export type ScenarioName = keyof typeof SCENARIOS;

/** The modules a measured process imports first, relative to its checkout — `requests.ts` smoke-tests them before a run. */
export const WORKER_MODULES = ['packages/testing/src/index.ts', 'apps/web-app/bootstrap/app.ts', 'apps/web-app/modules/auth/index.ts', 'packages/server/src/index.ts'] as const;

const repo = process.argv[2];
if (repo !== undefined && process.env.BENCH_WORKER === '1') await run(repo);

async function run(repo: string): Promise<void> {
  const chosen = (process.env.BENCH_SCENARIOS ?? 'login').split(',') as ScenarioName[];
  const rounds = Number(process.env.BENCH_ROUNDS ?? 3);
  const requests = Number(process.env.BENCH_REQUESTS ?? 10_000);
  const without = new Set((process.env.BENCH_WITHOUT ?? '').split(',').filter(Boolean));
  const imp = (path: string) => import(pathToFileURL(join(repo, path)).href);

  const [testing, bootstrap, auth, server] = WORKER_MODULES;
  const { createTestApp } = await imp(testing);
  const { default: application } = await imp(bootstrap);
  const { UserRepository } = await imp(auth);
  const { createHttpKernel } = await imp(server);

  // Without the CSP measure (W8 step 4): the app as it was before — no contentSecurityPolicy() among its global middleware.
  const definition =
    without.has('csp') && application.middleware?.global
      ? { ...application, middleware: { ...application.middleware, global: application.middleware.global.filter((m: { name?: string }) => m.name !== 'ContentSecurityPolicy') } }
      : application;
  const app = await createTestApp(definition, { database: 'refresh', seed: true, env: { SESSION_ENCRYPT: process.env.BENCH_ENCRYPT ?? 'false' } });
  try {
    const users = await app.make(UserRepository).query().selectAll().orderBy('id').execute();
    const browser = { 'sec-fetch-site': 'same-origin', referer: 'http://localhost/login' };
    const failed = await app.post('/login', { form: { email: 'nobody@example.com', password: 'wrong' }, headers: browser });
    const guestCookie = failed.cookie('bespoke_session');
    if (!guestCookie) throw new Error('A failed sign-in left no session cookie.');
    const signedIn = await app.post('/login', { form: { email: users[0].email, password: 'password' }, headers: browser });
    const userCookie = signedIn.cookie('bespoke_session');
    if (!userCookie) throw new Error('A sign-in left no session cookie.');
    // The server's work only: a kernel of the booted app, the request as a browser sends it (its cookies as the server set them),
    // the body read, the terminate hooks awaited — none of the test helpers' cookie decryption and session reading per response.
    const kernel = createHttpKernel(app.application);
    const page = { 'x-bespoke': 'true', accept: 'text/html, application/xhtml+xml', ...browser };
    const guestInit = { headers: { ...page, cookie: cookiesOf(failed.headers) } };
    const userInit = { headers: { ...page, cookie: cookiesOf(signedIn.headers) } };
    const documentInit = { headers: { accept: 'text/html', 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', cookie: cookiesOf(failed.headers) } };
    const send: Record<ScenarioName, () => Promise<Response>> = {
      login: () => kernel.request('/login', guestInit),
      'login-guest': () => kernel.request('/login', { headers: page }),
      'login-document': () => kernel.request('/login', documentInit),
      people: () => kernel.request('/people', userInit),
    };
    const loop = async (name: ScenarioName, n: number) => {
      for (let i = 0; i < n; i++) {
        const response = await send[name]();
        await response.arrayBuffer();
        await kernel.settle();
        if (response.status !== 200) throw new Error(`${name}: ${response.status}`);
      }
    };

    if (process.env.BENCH_CHECK === '1') {
      // The check of `--without` (requests.ts): one unsafe request with CSRF protection on (tests turn it off, and the scenarios
      // only read) — the Fetch Metadata stage runs for it, unless it is off (then the token is missing: 419).
      const { CsrfProtection } = await imp('packages/session/src/index.ts');
      const protection = app.make(CsrfProtection);
      protection.enable();
      await app.post('/login', { form: { email: 'nobody@example.com', password: 'wrong' }, headers: browser });
      protection.disable();
    }
    for (const name of chosen) await loop(name, 500); // warm-up: the JIT, the caches, the memoized epochs
    const profiler = process.env.BENCH_PROFILE ? new Session() : undefined;
    if (profiler) {
      profiler.connect();
      await profiler.post('Profiler.enable');
      await profiler.post('Profiler.setSamplingInterval', { interval: 50 });
      await profiler.post('Profiler.start');
    }
    const results: Record<string, number[]> = {};
    for (let round = 0; round < rounds; round++) {
      for (const name of chosen) {
        globalThis.gc?.();
        const started = performance.now();
        await loop(name, requests);
        (results[name] ??= []).push(((performance.now() - started) * 1000) / requests);
      }
    }
    if (profiler) {
      const { profile } = await profiler.post('Profiler.stop');
      writeFileSync(process.env.BENCH_PROFILE!, JSON.stringify(profile));
      profiler.disconnect();
    }
    const counters = (globalThis as { __bespokeBench?: { counters: Record<string, number> } }).__bespokeBench?.counters;
    process.stdout.write(`${JSON.stringify({ scenarios: results, requests: requests * rounds, ...(counters ? { counters } : {}) })}\n`);
  } finally {
    await app.close();
  }
}

/** The `Cookie` header a browser sends back after `headers` — every cookie they set, the values as set (encrypted). */
function cookiesOf(headers: Headers): string {
  return headers
    .getSetCookie()
    .map((header) => header.split(';')[0]!)
    .filter((pair) => !pair.endsWith('='))
    .join('; ');
}

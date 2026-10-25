/**
 * The CSP probe: a built app in headless Chrome under a second, strict policy (`style-src 'self'`, no `'unsafe-inline'`, no
 * nonce) and a counter of `securitypolicyviolation` events. Green when nothing is blocked and the framework's look arrived from
 * `@marmeon/react/styles.css`. Never a gate (CONTRIBUTING.md, "The repository").
 *
 *   node scripts/csp-probe.ts --app apps/web-app [--build]               # builds (with --build), starts `marmeon start`, probes
 *   node scripts/csp-probe.ts --app <kit> --profile kit [--build]        # a starter kit (pack:smoke --keep, create-marmeon)
 *   node scripts/csp-probe.ts --url http://127.0.0.1:3961 --profile web-app   # a server that already runs
 *   node scripts/csp-probe.ts --app apps/web-app --build --throwaway     # a fresh checkout: generated keys, temporary SQLite, seeded
 *
 * Needs Google Chrome (`--chrome <path>` or `CHROME`). Starts and stops its own processes by PID. Exit 0 green, 1 red, 2 setup.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

interface Profile {
  /** Who signs in (password `password`). */
  readonly email: string;
  readonly guest: readonly string[];
  readonly user: readonly string[];
  /** A layer by deep link, and the `--layer-depth` the app's frame writes through the CSSOM (the web app's). */
  readonly deepLayer?: { readonly url: string; readonly depthVariable: boolean };
  /** A layer opened by a click on `link` on `page`. */
  readonly clickLayer?: { readonly page: string; readonly link: string };
  /** A visit started by a click on `link` on `page` — failed (no network) and answered with a 500. */
  readonly failing: { readonly page: string; readonly link: string };
  /** The app's own look from its stylesheet, signed in (or as a guest with `guest: true`): on `url`, `selector`'s computed `property` is `expected`. */
  readonly looks?: readonly { readonly url: string; readonly selector: string; readonly property: string; readonly expected: string; readonly guest?: boolean }[];
}

const PROFILES: Record<string, Profile> = {
  'web-app': {
    email: 'ada@example.com',
    guest: ['/login', '/register', '/forgot-password', '/nowhere'],
    user: ['/dashboard', '/people', '/users/1', '/members', '/notifications', '/settings/security', '/settings/passkeys', '/settings/tokens'],
    deepLayer: { url: '/users/1/edit', depthVariable: true },
    clickLayer: { page: '/users/1', link: 'a[href="/users/1/edit"]' },
    failing: { page: '/people', link: 'main a[href="/users/1"]' },
  },
  kit: {
    email: 'test@example.com',
    guest: ['/', '/login', '/register', '/forgot-password', '/nowhere'],
    user: ['/dashboard', '/settings/security', '/settings/two-factor', '/settings/two-factor/verify', '/settings/passkeys', '/settings/tokens'],
    failing: { page: '/dashboard', link: 'a[href="/settings/security"]' },
    // The auth module's layouts: modules/auth/auth.css (make:auth imports it in bootstrap/client.tsx), no inline style.
    looks: [
      { url: '/login', selector: 'label.choice', property: 'display', expected: 'flex', guest: true },
      { url: '/dashboard', selector: 'body', property: 'font-family', expected: '"IBM Plex Sans Variable", system-ui, -apple-system, "Segoe UI", sans-serif' },
      { url: '/dashboard', selector: 'header.auth-header', property: 'display', expected: 'flex' },
      { url: '/settings/tokens', selector: '.auth-settings', property: 'display', expected: 'flex' },
      { url: '/settings/two-factor', selector: '.auth-settings', property: 'display', expected: 'flex' },
      { url: '/settings/passkeys', selector: '.auth-settings', property: 'display', expected: 'flex' },
      { url: '/settings/tokens', selector: 'label.choice', property: 'display', expected: 'flex' },
    ],
  },
};

/** The policy added to every document: what a strict app sets. */
const STRICT = "style-src 'self'; font-src 'self'";
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

class ProbeError extends Error {}

// ── processes ────────────────────────────────────────────────────────────────────────────────────────────────────────────

const children = new Set<ChildProcess>();
function stopAll(): void {
  for (const child of children) if (child.pid !== undefined && child.exitCode === null) process.kill(child.pid, 'SIGTERM');
}
process.on('exit', stopAll);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => process.exit(130));

/**
 * `--throwaway`: what a fresh checkout lacks — the variables the app cannot start without and a database with the profile's users —
 * in a temporary directory (its SQLite files are removed afterwards), never the app's own `.env` or `storage/`. `--env` still wins.
 */
function throwaway(app: string, env: Record<string, string>): { env: Record<string, string>; dir: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'marmeon-csp-probe-db-')));
  const prepared = {
    APP_NAME: 'csp-probe',
    APP_URL: 'http://127.0.0.1',
    APP_KEY: `base64:${randomBytes(32).toString('base64')}`,
    PAYMENTS_WEBHOOK_SECRET: randomBytes(24).toString('hex'),
    DB_DATABASE: join(dir, 'database.sqlite'),
    SYSTEM_DB_DATABASE: join(dir, 'system.sqlite'),
    ...env,
  };
  const seeded = spawnSync(join(app, 'node_modules/.bin/marmeon'), ['migrate:fresh', '--seed', '--force', '--no-types'], {
    cwd: app,
    env: { ...process.env, NODE_ENV: 'production', ...prepared },
    encoding: 'utf8',
  });
  if (seeded.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new ProbeError(`marmeon migrate:fresh --seed failed:\n${seeded.stdout}${seeded.stderr}`);
  }
  return { env: prepared, dir };
}

async function startServer(app: string, env: Record<string, string>): Promise<string> {
  const child = spawn(join(app, 'node_modules/.bin/marmeon'), ['start'], {
    cwd: app,
    env: { ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let output = '';
  child.stdout!.on('data', (chunk) => (output += chunk));
  child.stderr!.on('data', (chunk) => (output += chunk));
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const port = /on http:\/\/localhost:(\d+)/.exec(output)?.[1];
    if (port) return `http://127.0.0.1:${port}`;
    if (child.exitCode !== null) throw new ProbeError(`marmeon start exited with ${child.exitCode}:\n${output}`);
    await sleep(100);
  }
  throw new ProbeError(`marmeon start printed no address within 30 s:\n${output}`);
}

async function startChrome(binary: string): Promise<{ port: number; profile: string }> {
  const profile = realpathSync(mkdtempSync(join(tmpdir(), 'marmeon-csp-probe-')));
  const child = spawn(binary, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank'], {
    stdio: 'ignore',
  });
  children.add(child);
  const file = join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const port = Number(readFileSync(file, 'utf8').split('\n')[0]);
      if (port > 0) return { port, profile };
    }
    if (child.exitCode !== null) throw new ProbeError(`Chrome exited with ${child.exitCode}`);
    await sleep(100);
  }
  throw new ProbeError('Chrome wrote no DevToolsActivePort within 20 s');
}

// ── CDP ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

type Message = { id?: number; method?: string; params?: any; result?: any; error?: { message: string } };

class Tab {
  readonly #ws: WebSocket;
  #id = 0;
  readonly #pending = new Map<number, (message: Message) => void>();
  readonly #listeners = new Map<string, ((params: any) => void)[]>();
  /** What a visit's request (`x-marmeon`) meets: the network, no network, or a 500 with the built-in error page. */
  fail: 'no' | 'network' | 'server' = 'no';
  version: string | null = null;
  readonly failed: string[] = [];

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as Message;
      if (message.id !== undefined) {
        this.#pending.get(message.id)?.(message);
        this.#pending.delete(message.id);
      } else if (message.method) {
        for (const listener of this.#listeners.get(message.method) ?? []) listener(message.params);
      }
    });
  }

  static async open(port: number, base: string, cookies: readonly { name: string; value: string }[]): Promise<Tab> {
    const target = (await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()) as { webSocketDebuggerUrl: string };
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((done, fail) => {
      ws.addEventListener('open', done);
      ws.addEventListener('error', fail);
    });
    const tab = new Tab(ws);
    await tab.send('Emulation.setUserAgentOverride', { userAgent: UA }); // HeadlessChrome counts as a bot (isBot)
    await tab.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await tab.send('Page.enable');
    await tab.send('Runtime.enable');
    await tab.send('Network.enable');
    // The browser keeps one cookie jar for every tab: a check starts with the cookies it names and no others.
    await tab.send('Network.clearBrowserCookies');
    // Sign-in happens over HTTP and the cookie is set here: a form sign-in leaves headless Chrome deaf to CDP input.
    for (const cookie of cookies) await tab.send('Network.setCookie', { ...cookie, url: base });
    // The counter must exist before the first script of any document runs, or early violations go uncounted.
    await tab.send('Page.addScriptToEvaluateOnNewDocument', {
      source:
        "window.__violations = []; document.addEventListener('securitypolicyviolation', (e) => window.__violations.push(`${e.violatedDirective} ${e.blockedURI || ''} ${(e.sample || '').slice(0, 60)}`.trim()));",
    });
    tab.on('Fetch.requestPaused', (params) => void tab.#paused(params).catch((error: unknown) => tab.failed.push(`interception failed: ${String(error)}`)));
    await tab.send('Fetch.enable', {
      patterns: [
        { urlPattern: `${base}/*`, resourceType: 'Document', requestStage: 'Response' },
        { urlPattern: `${base}/*`, resourceType: 'Fetch', requestStage: 'Request' },
      ],
    });
    return tab;
  }

  on(method: string, listener: (params: any) => void): void {
    this.#listeners.set(method, [...(this.#listeners.get(method) ?? []), listener]);
  }

  async send(method: string, params: object = {}): Promise<any> {
    const id = ++this.#id;
    const answer = new Promise<Message>((done) => this.#pending.set(id, done));
    this.#ws.send(JSON.stringify({ id, method, params }));
    const message = await answer;
    if (message.error) throw new ProbeError(`${method}: ${message.error.message}`);
    return message.result;
  }

  async #paused(params: any): Promise<void> {
    const { requestId, request } = params;
    if (params.responseStatusCode !== undefined) {
      // A document: the strict style policy on top of the app's own.
      const headers = [...(params.responseHeaders ?? []), { name: 'Content-Security-Policy', value: STRICT }];
      await this.send('Fetch.continueResponse', { requestId, responseCode: params.responseStatusCode, responseHeaders: headers });
      return;
    }
    const visit = Object.keys(request.headers).some((name) => name.toLowerCase() === 'x-marmeon');
    if (!visit || this.fail === 'no') return void (await this.send('Fetch.continueRequest', { requestId }));
    this.failed.push(`${this.fail} ${request.url}`);
    if (this.fail === 'network') return void (await this.send('Fetch.failRequest', { requestId, errorReason: 'InternetDisconnected' }));
    const page = {
      component: 'errors/Error',
      props: { status: 500, title: 'Server Error', message: 'Server Error', exception: null },
      url: new URL(request.url).pathname,
      version: this.version,
    };
    await this.send('Fetch.fulfillRequest', {
      requestId,
      responseCode: 500,
      responseHeaders: [
        { name: 'content-type', value: 'application/json' },
        { name: 'x-marmeon', value: '1' },
      ],
      body: Buffer.from(JSON.stringify(page)).toString('base64'),
    });
  }

  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new ProbeError(`evaluate: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    return result.result.value as T;
  }

  async goto(url: string): Promise<void> {
    const loaded = new Promise<void>((done) => this.on('Page.loadEventFired', () => done()));
    await this.send('Page.navigate', { url });
    await Promise.race([loaded, sleep(15_000)]);
    await sleep(500); // hydration, the lazy chunks of the first page
  }

  /** Waits until `expression` is truthy (10 s). */
  async until(expression: string, what: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (await this.evaluate<boolean>(`Boolean(${expression})`)) return;
      await sleep(100);
    }
    throw new ProbeError(`${what} did not happen within 10 s`);
  }

  /** A real click (user activation, focus) at the element's centre. */
  async click(selector: string): Promise<void> {
    const box = await this.evaluate<{ x: number; y: number } | null>(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    );
    if (!box) throw new ProbeError(`no element ${selector}`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'] as const) {
      await this.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
    }
  }

  async key(key: string, code: string, keyCode: number): Promise<void> {
    for (const type of ['keyDown', 'keyUp'] as const) await this.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: keyCode });
  }

  violations(): Promise<string[]> {
    return this.evaluate<string[]>('window.__violations ?? []');
  }

  close(): void {
    this.#ws.close();
  }
}

// ── the checks ───────────────────────────────────────────────────────────────────────────────────────────────────────────

async function signIn(base: string, email: string): Promise<{ name: string; value: string }[]> {
  const jar = new Map<string, string>();
  const keep = (response: Response) => {
    for (const cookie of response.headers.getSetCookie()) {
      const [pair = ''] = cookie.split(';');
      const at = pair.indexOf('=');
      jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
  };
  const cookie = () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
  const page = await fetch(`${base}/login`, { headers: { accept: 'text/html' } });
  keep(page);
  const html = await page.text();
  const token = /"csrf":"([^"]+)"/.exec(html)?.[1] ?? /name="_token" value="([^"]+)"/.exec(html)?.[1] ?? '';
  const response = await fetch(`${base}/login`, {
    method: 'POST',
    redirect: 'manual',
    body: new URLSearchParams({ email, password: 'password', _token: token }),
    headers: { cookie: cookie(), 'content-type': 'application/x-www-form-urlencoded', origin: base, referer: `${base}/login`, 'sec-fetch-site': 'same-origin' },
  });
  keep(response);
  if (response.status !== 302 && response.status !== 303) throw new ProbeError(`signing in as ${email} answered ${response.status} — seeded? (password "password")`);
  return [...jar].map(([name, value]) => ({ name, value }));
}

interface Result {
  readonly name: string;
  readonly problems: readonly string[];
}

async function probe(port: number, base: string, profile: Profile): Promise<{ results: Result[]; policy: string | null }> {
  const results: Result[] = [];
  const session = await signIn(base, profile.email);
  const policy = (await fetch(`${base}/login`, { headers: { accept: 'text/html' } })).headers.get('content-security-policy');

  const check = async (name: string, cookies: readonly { name: string; value: string }[], run: (tab: Tab, problems: string[]) => Promise<void>) => {
    const tab = await Tab.open(port, base, cookies);
    const problems: string[] = [];
    try {
      await run(tab, problems);
      await sleep(300);
      const violations = await tab.violations();
      if (violations.length > 0) problems.unshift(`${violations.length} CSP violation(s): ${violations.join(' | ')}`);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    } finally {
      tab.close();
    }
    results.push({ name, problems });
  };
  /** The look of styles.css arrived: a property its rule sets, as computed. */
  const looks = async (tab: Tab, selector: string, property: string, expected: string, problems: string[]) => {
    const actual = await tab.evaluate<string | null>(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? getComputedStyle(el).getPropertyValue(${JSON.stringify(property)}) : null; })()`);
    if (actual !== expected) problems.push(`${selector}: ${property} is ${actual} — expected ${expected} (styles.css not applied?)`);
  };

  for (const url of profile.guest) {
    await check(`guest ${url}`, [], async (tab) => {
      await tab.goto(base + url);
      if (url === '/nowhere') await tab.until(`document.querySelector('main.marmeon-error')`, 'the built-in error page');
    });
  }
  for (const url of profile.user) {
    await check(`signed in ${url}`, session, async (tab, problems) => {
      await tab.goto(base + url);
      const path = await tab.evaluate<string>('location.pathname');
      if (path !== url) problems.push(`landed on ${path} instead of ${url}`);
    });
  }
  for (const look of profile.looks ?? []) {
    await check(`the app's look on ${look.url}: ${look.selector}`, look.guest ? [] : session, async (tab, problems) => {
      await tab.goto(base + look.url);
      await looks(tab, look.selector, look.property, look.expected, problems);
    });
  }
  if (profile.deepLayer) {
    const { url, depthVariable } = profile.deepLayer;
    await check(`layer by deep link ${url}`, session, async (tab, problems) => {
      await tab.goto(base + url);
      await tab.until(`document.querySelector('dialog[data-marmeon-layer]')?.matches(':modal')`, 'the layer as a modal dialog');
      await looks(tab, 'dialog[data-marmeon-layer]', 'border-top-left-radius', '8px', problems);
      await looks(tab, 'dialog[data-marmeon-layer] > .marmeon-layer__content', 'padding-top', '24px', problems);
      await looks(tab, 'dialog[data-marmeon-layer] > .marmeon-layer__close', 'position', 'absolute', problems);
      if (depthVariable) {
        const depth = await tab.evaluate<string>(`document.querySelector('dialog[data-marmeon-layer]').style.getPropertyValue('--layer-depth')`);
        if (depth !== '1') problems.push(`the frame's style prop (--layer-depth through the CSSOM) is "${depth}" — expected "1"`);
      }
    });
  }
  if (profile.clickLayer) {
    const { page, link } = profile.clickLayer;
    await check(`layer by a click on ${page}, Escape, focus back`, session, async (tab, problems) => {
      await tab.goto(base + page);
      await tab.click(link);
      await tab.until(`document.querySelector('dialog[data-marmeon-layer]')?.matches(':modal')`, 'the layer opened by the click');
      await looks(tab, 'dialog[data-marmeon-layer]', 'border-top-left-radius', '8px', problems);
      await sleep(300);
      if (!(await tab.evaluate<boolean>(`document.querySelector('dialog[data-marmeon-layer]').contains(document.activeElement)`))) {
        problems.push(`the focus is not inside the layer: ${await tab.evaluate<string>('document.activeElement?.outerHTML.slice(0, 80) ?? "none"')}`);
      }
      await tab.key('Escape', 'Escape', 27);
      await tab.until(`!document.querySelector('dialog[data-marmeon-layer]')`, 'Escape closing the layer');
      await sleep(200);
      if (!(await tab.evaluate<boolean>(`document.activeElement === document.querySelector(${JSON.stringify(link)})`))) {
        problems.push(`the focus did not return to ${link}: ${await tab.evaluate<string>('document.activeElement?.outerHTML.slice(0, 80) ?? "none"')}`);
      }
    });
  }
  const { page, link } = profile.failing;
  await check(`a visit without network (from ${page})`, session, async (tab, problems) => {
    await tab.goto(base + page);
    tab.fail = 'network';
    await tab.evaluate(`document.querySelector(${JSON.stringify(link)}).click()`);
    await tab.until(`document.querySelector('[data-marmeon-failure="network"]')`, 'the notice of an unreachable server');
    if (tab.failed.length === 0) problems.push('no visit went out');
    await looks(tab, '[data-marmeon-failure="network"]', 'position', 'fixed', problems);
    const path = await tab.evaluate<string>('location.pathname');
    if (path !== page) problems.push(`the page left: ${path}`);
  });
  await check(`a visit answered with a 500 (from ${page})`, session, async (tab, problems) => {
    await tab.goto(base + page);
    tab.version = await tab.evaluate<string | null>(`JSON.parse(document.getElementById('marmeon-page').textContent).version ?? null`);
    tab.fail = 'server';
    await tab.evaluate(`document.querySelector(${JSON.stringify(link)}).click()`);
    await tab.until(`document.querySelector('dialog[data-marmeon-failure="server"] main.marmeon-error h1')`, 'the dialog with the built-in error page');
    await looks(tab, 'dialog[data-marmeon-failure="server"]', 'border-top-left-radius', '8px', problems);
    await looks(tab, 'dialog[data-marmeon-failure="server"] main.marmeon-error', 'max-width', '720px', problems);
    if (!(await tab.evaluate<boolean>(`document.querySelector('dialog[data-marmeon-failure="server"]').matches(':modal')`))) problems.push('the error dialog is not modal');
  });
  return { results, policy };
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      app: { type: 'string' },
      url: { type: 'string' },
      profile: { type: 'string', default: 'web-app' },
      build: { type: 'boolean' },
      chrome: { type: 'string' },
      env: { type: 'string', multiple: true },
      throwaway: { type: 'boolean' },
    },
  });
  const profile = PROFILES[values.profile!];
  if (!profile) {
    console.error(`csp:probe: no profile "${values.profile}" — known: ${Object.keys(PROFILES).join(', ')}`);
    return 2;
  }
  const chrome = values.chrome ?? process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (!existsSync(chrome)) {
    console.error(`csp:probe: no Chrome at ${chrome} — pass --chrome <path> or CHROME`);
    return 2;
  }
  let profileDir: string | undefined;
  let databaseDir: string | undefined;
  try {
    let base = values.url;
    if (!base) {
      if (!values.app) throw new ProbeError('pass --app <dir> (started here) or --url <base> (already running)');
      const app = resolve(values.app);
      if (values.build) {
        const built = spawnSync(join(app, 'node_modules/.bin/marmeon'), ['build'], { cwd: app, env: { ...process.env, NODE_ENV: 'production' }, encoding: 'utf8' });
        if (built.status !== 0) throw new ProbeError(`marmeon build failed:\n${built.stdout}${built.stderr}`);
      }
      let env = Object.fromEntries((values.env ?? []).map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]));
      if (values.throwaway) ({ env, dir: databaseDir } = throwaway(app, env));
      base = await startServer(app, env);
    }
    const started = await startChrome(chrome);
    profileDir = started.profile;
    const { results, policy } = await probe(started.port, base, profile);
    console.log(`csp:probe: ${base} (profile ${values.profile}) — the app's policy: ${policy ?? 'none'}; added: ${STRICT}`);
    for (const result of results) console.log(result.problems.length === 0 ? `  ✓ ${result.name}: 0 violations` : `  ✗ ${result.name}: ${result.problems.join('; ')}`);
    const red = results.filter((result) => result.problems.length > 0);
    console.log(red.length === 0 ? `csp:probe: green — ${results.length} checks, 0 violations.` : `csp:probe: ${red.length} of ${results.length} checks red.`);
    return red.length === 0 ? 0 : 1;
  } catch (error) {
    console.error(`csp:probe: ${error instanceof Error ? error.message : String(error)}`);
    return error instanceof ProbeError ? 1 : 2;
  } finally {
    stopAll();
    await sleep(300);
    if (profileDir) rmSync(profileDir, { recursive: true, force: true });
    if (databaseDir) rmSync(databaseDir, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exitCode = await main();

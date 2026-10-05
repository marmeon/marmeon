import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { inspectApp } from './commands/make-docker.ts';
import { HEALTHCHECK_SCRIPT, TESTED_PNPM } from './docker.ts';

const repo = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const bin = join(repo, 'packages/cli/bin/bespoke.js');
const temporary: string[] = [];
afterAll(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

function app(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bespoke-docker-')));
  temporary.push(root);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  return root;
}

function makeDocker(cwd: string, ...args: string[]) {
  const { BESPOKE_CHILD: _child, ...parent } = process.env;
  const result = spawnSync(process.execPath, [bin, 'make:docker', ...args], { cwd, encoding: 'utf8', env: { ...parent, NO_COLOR: '1' } });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, file: (name: string) => readFileSync(join(cwd, name), 'utf8') };
}

const pnpmApp = () =>
  app({
    'package.json': JSON.stringify({ name: '@acme/shop', packageManager: 'pnpm@12.9.0+sha512.abc', dependencies: { '@bespokecore/core': 'file:./vendor/fw/core.tgz' } }),
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    'pnpm-workspace.yaml': 'overrides:\n  "@bespokecore/http": "file:./vendor/fw/http.tgz"\n  "left-pad": "file:../outside/left-pad.tgz"\n',
  });

// `bespoke make:docker` (E140, E141, E163): the image, its context, the roles, the proxies.
describe('bespoke make:docker', () => {
  it('writes a multi-stage Dockerfile for a pnpm app: pinned pnpm, frozen lockfile, build, production install, non-root, health check, bespoke as the process', () => {
    const root = pnpmApp();
    const result = makeDocker(root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Created Dockerfile');
    const dockerfile = result.file('Dockerfile');
    expect(dockerfile).toContain('ARG NODE_IMAGE=node:26-slim');
    expect(dockerfile).toContain('RUN npm install --global --no-audit --no-fund pnpm@12.9.0\n');
    // The install files and the local packages the lockfile points to come before the install; one outside the context is named.
    expect(dockerfile).toContain('COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./\nCOPY vendor/fw ./vendor/fw\nRUN --mount=type=cache');
    expect(result.stderr).toContain('Local packages outside the app cannot reach the Docker build (its context is the app): ../outside/left-pad.tgz');
    expect(dockerfile).toContain('pnpm install --frozen-lockfile --store-dir /pnpm/store');
    expect(dockerfile).toContain('NODE_ENV=production node_modules/.bin/bespoke build');
    expect(dockerfile).toContain('rm -rf node_modules \\\n && pnpm install --prod --frozen-lockfile');
    expect(dockerfile).toContain('&& node_modules/.bin/bespoke discover');
    expect(dockerfile).toMatch(/ENV NODE_ENV=production HOST=0\.0\.0\.0 PORT=3000/);
    expect(dockerfile).toMatch(/\nUSER node\n/);
    expect(dockerfile).toContain('ENTRYPOINT ["bespoke"]\nCMD ["start"]\n');
    expect(dockerfile).toContain('chown -R node:node storage');
    // The image has no .env: every one stays out of the context but the example (removed after the build).
    expect(result.file('.dockerignore')).toMatch(/^\.env\*\n!\.env\.example\n/m);
    expect(dockerfile).toContain('rm -f .env .env.example');
    for (const ignored of ['node_modules', 'dist', '.bespoke', 'storage']) expect(result.file('.dockerignore')).toMatch(new RegExp(`^${ignored.replace('.', '\\.')}$`, 'm'));

    const compose = result.file('compose.production.yaml');
    expect(compose).toContain('image: shop');
    expect(compose).toContain('init: true');
    expect(compose).toContain("command: ['start']");
    expect(compose).toContain("command: ['queue:work', '--queue=mail,default']");
    expect(compose).toContain("command: ['schedule:work']");
    expect(compose.match(/healthcheck:\n {6}disable: true/g)).toHaveLength(2);
    expect(compose).toContain("      - '3000:3000'");
    expect(existsSync(join(root, 'deploy'))).toBe(false);
  });

  it('writes the npm variant for an app with package-lock.json — no pnpm in the image', () => {
    const root = app({ 'package.json': JSON.stringify({ name: 'blog' }), 'package-lock.json': '{}', '.npmrc': 'fund=false\n' });
    const dockerfile = makeDocker(root).file('Dockerfile');
    expect(dockerfile).toContain('COPY package.json package-lock.json .npmrc ./');
    expect(dockerfile).toContain('npm ci --no-audit --no-fund');
    expect(dockerfile).toContain('npm prune --omit=dev');
    expect(dockerfile).not.toContain('pnpm');
  });

  it('refuses an app without a lockfile, two proxies, and existing files without --force', () => {
    expect(makeDocker(app({ 'package.json': '{}' })).stderr).toContain('No lockfile (pnpm-lock.yaml or package-lock.json): install the dependencies first');
    const root = pnpmApp();
    expect(makeDocker(root, '--caddy', '--nginx').stderr).toContain('Choose one proxy: --caddy or --nginx.');
    expect(makeDocker(root).code).toBe(0);
    const again = makeDocker(root);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('Dockerfile, .dockerignore, compose.production.yaml already exist (use --force to overwrite).');
    expect(makeDocker(root, '--force').code).toBe(0);
  });

  it('pins the tested pnpm when the app names none — the version the repository runs', () => {
    const root = app({ 'package.json': JSON.stringify({ name: 'x' }), 'pnpm-lock.yaml': '' });
    const app_ = inspectApp(root);
    if (typeof app_ === 'string') throw new Error(app_);
    expect(app_.docker.pnpmVersion).toBe(TESTED_PNPM);
    expect(app_.notes[0]).toContain(`package.json names no "packageManager": the Dockerfile pins pnpm@${TESTED_PNPM}`);
    const pinned = (JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { packageManager: string }).packageManager;
    expect(`pnpm@${TESTED_PNPM}`).toBe(pinned);
  });

  it('--caddy: Caddy in front (h2/h3, TLS), the web container unpublished and trusting it; --nginx: X-Forwarded-* set, buffering off for streams', () => {
    const caddy = makeDocker(pnpmApp(), '--caddy');
    const compose = caddy.file('compose.production.yaml');
    expect(compose).toContain('image: caddy:2');
    expect(compose).toContain("      - '443:443/udp'");
    expect(compose).toContain("TRUSTED_PROXIES: '*'");
    expect(compose).not.toContain("'3000:3000'");
    const caddyfile = caddy.file('deploy/Caddyfile');
    expect(caddyfile).toContain('{$APP_DOMAIN} {');
    expect(caddyfile).toContain('reverse_proxy web:3000');
    expect(caddyfile).not.toMatch(/^\s*encode/m);

    const nginx = makeDocker(pnpmApp(), '--nginx');
    const conf = nginx.file('deploy/nginx.conf');
    expect(conf).toContain('server web:3000;');
    expect(conf).toContain('http2 on;');
    expect(conf).toContain('proxy_set_header X-Forwarded-Proto $scheme;');
    // The client's address as nginx sees it — replaced, never appended to the client's own list (the app trusts '*' here).
    expect(conf).toContain('proxy_set_header X-Forwarded-For $remote_addr;');
    expect(conf).not.toContain('X-Forwarded-For $proxy_add_x_forwarded_for');
    expect(conf).toContain('proxy_read_timeout 75s;');
    expect(nginx.file('compose.production.yaml')).toContain('image: nginx:mainline-alpine');
  });

  it('--systemd: a unit per role (restart, TimeoutStopSec, loopback + trusted proxy for the web) — the proxy then on the host', () => {
    const result = makeDocker(pnpmApp(), '--systemd', '--caddy');
    const web = result.file('deploy/systemd/web.service');
    expect(web).toContain('ExecStart=/srv/shop/node_modules/.bin/bespoke start');
    expect(web).toContain('Environment=HOST=127.0.0.1 PORT=3000 TRUSTED_PROXIES=127.0.0.1');
    expect(web).toContain('TimeoutStopSec=30');
    expect(web).toContain('ReadWritePaths=/srv/shop/storage');
    expect(result.file('deploy/systemd/worker.service')).toContain('ExecStart=/srv/shop/node_modules/.bin/bespoke queue:work --queue=mail,default');
    expect(result.file('deploy/systemd/worker.service')).toContain('Restart=always');
    expect(result.file('deploy/systemd/scheduler.service')).toContain('bespoke schedule:work');
    expect(result.file('deploy/Caddyfile')).toContain('reverse_proxy 127.0.0.1:3000');
    // Compose then publishes the web server on loopback for the host's proxy, and runs no proxy of its own.
    expect(result.file('compose.production.yaml')).toContain("- '127.0.0.1:3000:3000'");
    expect(result.file('compose.production.yaml')).not.toContain('caddy:2');
  });
});

// The image's HEALTHCHECK (E126): healthy on 200 from /up only — a draining server (503) or none at all is unhealthy.
describe('the health check of the image', () => {
  async function serve(status: number): Promise<Server> {
    const server = createServer((req, res) => {
      res.statusCode = req.url === '/up' ? status : 404;
      res.end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return server;
  }
  async function check(port: number, env: Record<string, string> = {}): Promise<number | null> {
    const child = spawn(process.execPath, ['-e', HEALTHCHECK_SCRIPT], { env: { PATH: process.env.PATH, PORT: String(port), ...env }, stdio: 'ignore' });
    const [code] = (await once(child, 'exit')) as [number | null];
    return code;
  }

  it('exits 0 for 200, 1 for 503, 1 when nothing listens; follows PORT and HEALTH_PATH', async () => {
    const up = await serve(200);
    const draining = await serve(503);
    try {
      expect(await check((up.address() as AddressInfo).port)).toBe(0);
      expect(await check((draining.address() as AddressInfo).port)).toBe(1);
      expect(await check((up.address() as AddressInfo).port, { HEALTH_PATH: '/healthz' })).toBe(1);
      const closed = (draining.address() as AddressInfo).port;
      draining.close();
      await once(draining, 'close');
      expect(await check(closed)).toBe(1);
    } finally {
      up.close();
    }
  });

  it('is the command in the Dockerfile', () => {
    const root = pnpmApp();
    makeDocker(root);
    expect(readFileSync(join(root, 'Dockerfile'), 'utf8')).toContain(`CMD ["node", "-e", ${JSON.stringify(HEALTHCHECK_SCRIPT)}]`);
  });
});

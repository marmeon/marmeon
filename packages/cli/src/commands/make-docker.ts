import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative } from 'node:path';
import type { CommandInput } from '../command.ts';
import { caddyfile, compose, dockerfile, dockerignore, nginxConf, systemdUnits, TESTED_PNPM, type DockerApp, type PackageManager, type Proxy } from '../docker.ts';
import { style } from '../output.ts';

/**
 * `bespoke make:docker [--caddy|--nginx] [--systemd] [--force]` (E140, E141): the files to run the app in production — a
 * Dockerfile (multi-stage, `node:26-slim`, the app's package manager pinned, non-root, health check, `bespoke` as the process),
 * `.dockerignore` (no `.env*`), `compose.production.yaml` (web, worker, scheduler — one role per container; tini is the image's PID 1), with
 * `--caddy`/`--nginx` a reverse proxy in front of it, with `--systemd` units for running without Docker. Yours to change.
 */
export class MakeDockerCommand {
  static command = 'make:docker';
  static description = 'Create a Dockerfile, .dockerignore and compose.production.yaml (--caddy/--nginx: a proxy; --systemd: units)';
  static usage = '[--caddy|--nginx] [--systemd] [--force]';
  static options = { caddy: { type: 'boolean' }, nginx: { type: 'boolean' }, systemd: { type: 'boolean' }, force: { type: 'boolean' } } as const;
  static boots = false;

  handle({ options, output, root }: CommandInput): number {
    if (options.caddy === true && options.nginx === true) {
      output.error('Choose one proxy: --caddy or --nginx.');
      return 1;
    }
    const app = inspectApp(root);
    if (typeof app === 'string') {
      output.error(app);
      return 1;
    }
    const proxy: Proxy | undefined = options.caddy === true ? 'caddy' : options.nginx === true ? 'nginx' : undefined;
    const systemd = options.systemd === true;
    const files: Record<string, string> = {
      Dockerfile: dockerfile(app.docker),
      '.dockerignore': dockerignore(),
      'compose.production.yaml': compose(app.docker, { proxy, systemd }),
      ...(proxy === 'caddy' ? { 'deploy/Caddyfile': caddyfile({ systemd }) } : {}),
      ...(proxy === 'nginx' ? { 'deploy/nginx.conf': nginxConf({ systemd }) } : {}),
      ...(systemd ? Object.fromEntries(Object.entries(systemdUnits(app.docker)).map(([role, unit]) => [`deploy/systemd/${role}.service`, unit])) : {}),
    };
    const existing = Object.keys(files).filter((file) => existsSync(join(root, file)));
    if (existing.length > 0 && options.force !== true) {
      output.error(`${existing.join(', ')} already exist${existing.length === 1 ? 's' : ''} (use --force to overwrite).`);
      return 1;
    }
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), content);
      output.success(`Created ${file}`);
    }
    for (const note of app.notes) output.warn(note);
    output.line();
    output.line('Build and run it:');
    output.line(style('dim', `  docker build -t ${app.docker.name} .`));
    output.line(style('dim', `  docker compose -f compose.production.yaml up -d --build   # with .env.production on the server`));
    output.line();
    output.line(`Production configuration goes into ${style('bold', '.env.production')} (APP_KEY, APP_URL=https://…, DB_*, MAIL_MAILER=smtp) —`);
    output.line('never into the image; storage/ is a volume. Proxies, Kubernetes, SHUTDOWN_DELAY: https://github.com/bespokecore/bespokecore/blob/main/docs/deployment.md');
    return 0;
  }
}

/** What the files depend on: name, package manager (by its lockfile), the pinned pnpm, local packages the install needs. */
export function inspectApp(root: string): { docker: DockerApp; notes: string[] } | string {
  const file = join(root, 'package.json');
  if (!existsSync(file)) return `No package.json in ${root} — run bespoke make:docker in the app's directory.`;
  const manifest = JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
  const notes: string[] = [];
  const declared = typeof manifest.packageManager === 'string' ? /^(pnpm|npm)@(\d+\.\d+\.\d+[^+]*)/.exec(manifest.packageManager) : null;
  const lockfiles: PackageManager[] = [
    ...(existsSync(join(root, 'pnpm-lock.yaml')) ? (['pnpm'] as const) : []),
    ...(existsSync(join(root, 'package-lock.json')) ? (['npm'] as const) : []),
  ];
  const packageManager = (declared && lockfiles.includes(declared[1] as PackageManager) ? declared[1] : lockfiles[0]) as PackageManager | undefined;
  if (!packageManager) {
    return 'No lockfile (pnpm-lock.yaml or package-lock.json): install the dependencies first — the image installs exactly what the lockfile says (--frozen-lockfile).';
  }
  let pnpmVersion = TESTED_PNPM;
  if (packageManager === 'pnpm') {
    if (declared?.[1] === 'pnpm') pnpmVersion = declared[2]!;
    else notes.push(`package.json names no "packageManager": the Dockerfile pins pnpm@${TESTED_PNPM}, the version BespokeCore is tested with — set "packageManager": "pnpm@<version>" to choose (then run make:docker --force).`);
  }
  const installFiles = (packageManager === 'pnpm' ? ['pnpm-workspace.yaml', '.npmrc'] : ['.npmrc']).filter((name) => existsSync(join(root, name)));
  const { dirs, outside } = localPackages(root, manifest, installFiles.includes('pnpm-workspace.yaml') ? readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8') : '');
  if (outside.length > 0) notes.push(`Local packages outside the app cannot reach the Docker build (its context is the app): ${outside.join(', ')}`);
  const name = String(manifest.name ?? '')
    .replace(/^@[^/]+\//, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '');
  return { docker: { name: name || 'app', packageManager, pnpmVersion, installFiles, localPackages: dirs }, notes };
}

/** `file:`/`link:` dependencies and overrides that point into the app — their directories go into the image before the install. */
function localPackages(root: string, manifest: Record<string, any>, workspace: string): { dirs: string[]; outside: string[] } {
  const specs: string[] = [];
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'overrides']) {
    for (const value of Object.values((manifest[field] ?? {}) as Record<string, unknown>)) if (typeof value === 'string') specs.push(value);
  }
  for (const value of Object.values((manifest.pnpm?.overrides ?? {}) as Record<string, unknown>)) if (typeof value === 'string') specs.push(value);
  for (const match of workspace.matchAll(/(?:file|link):([^"'\s,}]+)/g)) specs.push(`file:${match[1]}`);
  const dirs = new Set<string>();
  const outside = new Set<string>();
  for (const spec of specs) {
    const path = /^(?:file|link):(.+)$/.exec(spec)?.[1];
    if (!path) continue;
    const target = /\.(tgz|tar\.gz)$/.test(path) ? dirname(path) : path;
    const inside = relative(root, join(root, target));
    if (isAbsolute(target) || inside.startsWith('..')) outside.add(path);
    else if (inside !== '') dirs.add(normalize(inside).split(/[/\\]/).join('/'));
  }
  // A directory inside another one is copied with it.
  const sorted = [...dirs].sort();
  return { dirs: sorted.filter((dir) => !sorted.some((other) => other !== dir && dir.startsWith(`${other}/`))), outside: [...outside] };
}

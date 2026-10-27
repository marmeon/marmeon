/**
 * The files `marmeon make:docker` writes: a multi-stage Dockerfile on `node:26-slim`, its `.dockerignore`, a
 * Compose file with one role per container, a reverse proxy (Caddy or nginx) and systemd units. Plain strings, so a test can
 * read every line the user gets — and run the health check.
 */

/** The pnpm the framework is tested with — pinned in a Dockerfile when the app names none (`packageManager`). */
export const TESTED_PNPM = '12.9.1';

/** The base image of every stage: Debian with glibc — native addons (oxc, rolldown, lightningcss) work as on a dev machine. */
export const NODE_IMAGE = 'node:26-slim';

export type PackageManager = 'pnpm' | 'npm';
export type Proxy = 'caddy' | 'nginx';

export interface DockerApp {
  /** The image and service name: the package name without its scope (`my-app`). */
  readonly name: string;
  readonly packageManager: PackageManager;
  /** The exact pnpm version to install (pnpm only). */
  readonly pnpmVersion: string;
  /** Files next to `package.json` the install needs: `pnpm-workspace.yaml`, `.npmrc`. */
  readonly installFiles: readonly string[];
  /** Directories of local packages the lockfile points to (`file:./vendor/x.tgz` → `vendor`), copied before the install. */
  readonly localPackages: readonly string[];
}

export interface DockerOptions {
  readonly proxy?: Proxy;
  /** systemd units too — and the proxy then runs on the host, in front of `127.0.0.1:3000`. */
  readonly systemd?: boolean;
}

/**
 * The health check of the image: Node's `fetch` — no curl in a slim image — on `/up`, 200 or it fails. It follows `PORT` and
 * `SERVER_HEALTH_PATH` like the server (an empty one counts as missing); `SERVER_HEALTH_PATH=off` turns the server's endpoints off, so it checks nothing.
 */
export const HEALTHCHECK_SCRIPT =
  "const p=process.env.SERVER_HEALTH_PATH||'/up';p==='off'?process.exit(0):fetch('http://127.0.0.1:'+(process.env.PORT||3000)+p).then(r=>process.exit(r.status===200?0:1),()=>process.exit(1))";

export function dockerfile(app: DockerApp): string {
  const pnpm = app.packageManager === 'pnpm';
  const lockfile = pnpm ? 'pnpm-lock.yaml' : 'package-lock.json';
  const manifests = ['package.json', lockfile, ...app.installFiles].join(' ');
  const cache = pnpm ? '--mount=type=cache,id=pnpm-store,target=/pnpm/store' : '--mount=type=cache,id=npm-cache,target=/root/.npm';
  const install = pnpm ? 'pnpm install --frozen-lockfile --store-dir /pnpm/store' : 'npm ci --no-audit --no-fund';
  // A fresh install of the production dependencies — \`pnpm install --prod\` over the full one unlinks the dev dependencies but
  // leaves them in node_modules/.pnpm.
  const prune = pnpm ? 'rm -rf node_modules \\\n && pnpm install --prod --frozen-lockfile --prefer-offline --store-dir /pnpm/store' : 'npm prune --omit=dev --no-audit --no-fund';
  return `# syntax=docker/dockerfile:1
# Written by \`marmeon make:docker\` — yours from now on. One image for every role: \`start\` (the web server, the default),
# \`queue:work\` and \`schedule:work\` — compose.production.yaml runs each in a container of its own.
#
#   docker build -t ${app.name} .
#   docker run -p 3000:3000 --env-file .env.production -v ${app.name}-storage:/app/storage ${app.name}
#
# The app stays TypeScript: Node runs its .ts files; \`marmeon build\` adds the bundles, the injection lists and the
# discovery manifest. Configuration and secrets (APP_KEY, APP_URL, DB_*, MAIL_*) come from the environment when the container
# runs — never from a file in the image: .dockerignore keeps every .env* out of the build.

ARG NODE_IMAGE=${NODE_IMAGE}

# ── Build: every dependency, \`marmeon build\`, then only the production dependencies ─────────────────────────────────────
FROM \${NODE_IMAGE} AS build
${pnpm ? `# pnpm as the app pins it ("packageManager" in package.json) — Node ships no Corepack since 25.\nRUN npm install --global --no-audit --no-fund pnpm@${app.pnpmVersion}\n` : ''}WORKDIR /app
# The dependencies first: this layer is rebuilt only when they change, not with every change of the code.
COPY ${manifests} ./
${app.localPackages.map((dir) => `COPY ${dir} ./${dir}\n`).join('')}RUN ${cache} ${install}
COPY . .
# \`marmeon build\` needs no .env and no secret: it registers the app's providers without booting them (the route types) —
# no APP_KEY, no database, nothing that could end up in the image.
RUN NODE_ENV=production node_modules/.bin/marmeon build
# Production dependencies only — marmeon is one; typescript, vite and vitest leave. Then the discovery manifest of exactly
# these packages: the start rewrites nothing, and the app's files may be read-only.
RUN ${cache} ${prune} \\
 && node_modules/.bin/marmeon discover

# ── Run: Node and the app, nothing to build with ───────────────────────────────────────────────────────────────────────
FROM \${NODE_IMAGE}
# tini as PID 1: Node as PID 1 reaps no orphaned process (they stay zombies), and the kernel drops a signal to PID 1 that
# has no handler yet — tini passes SIGTERM on to marmeon and ends with its exit code (0 after the drain, 70 for a stuck job).
RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 PATH=/app/node_modules/.bin:$PATH
WORKDIR /app
# The code belongs to root — the app cannot change it — and everyone may read it (a lockfile a package manager wrote with 0600
# would stop the start); storage/ (sessions, cache, uploads, SQLite, the compile cache) belongs to the user the app runs as.
# Mount a volume there (compose.production.yaml does): a container's own files are gone with the container.
COPY --from=build --chmod=a+rX /app ./
RUN mkdir -p storage/app/private storage/app/public storage/framework/cache storage/framework/sessions \\
 && chown -R node:node storage
USER node
EXPOSE 3000
# Liveness (/up) with Node's fetch — the image has no curl; it follows PORT and SERVER_HEALTH_PATH (SERVER_HEALTH_PATH=off: no check).
# The worker and scheduler containers turn it off (compose).
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \\
  CMD ["node", "-e", ${JSON.stringify(HEALTHCHECK_SCRIPT)}]
# marmeon is the process — one Node — under tini, which only passes signals on and reaps orphans.
ENTRYPOINT ["/usr/bin/tini", "--", "marmeon"]
CMD ["start"]
`;
}

export function dockerignore(): string {
  return `# Written by \`marmeon make:docker\` — what never enters the build context, and so never the image.
# Every .env file: the image gets its configuration from the environment when it runs (a developer's .env on a server would
# switch on the development tools) — and \`marmeon build\` needs none.
.env*
# Installed and built inside the image.
node_modules
dist
.marmeon
# What the app writes when it runs — a volume in production.
storage
# Not needed to run.
.git
coverage
*.log
.DS_Store
Dockerfile
.dockerignore
compose*.yaml
deploy
`;
}

export function compose(app: DockerApp, { proxy, systemd = false }: DockerOptions): string {
  // With --systemd the proxy runs on the host (deploy/…), in front of the published port.
  const proxied = proxy !== undefined && !systemd;
  const web = [
    '  web:',
    '    <<: *app',
    "    command: ['start']",
    ...(proxied
      ? []
      : ['    ports:', systemd || proxy ? "      - '127.0.0.1:3000:3000'" : "      - '3000:3000'"]),
    '    environment:',
    ...(proxied
      ? [
          `      # Only ${proxy === 'caddy' ? 'Caddy' : 'nginx'} reaches this container (it publishes no port), so its X-Forwarded-* count. Publish a port and`,
          "      # this would trust anyone: name the proxy's address or network instead.",
          "      SERVER_TRUSTED_PROXIES: '*'",
        ]
      : proxy
        ? ["      # The proxy on this host connects through Docker's port forwarding: its address as the container sees it, e.g.", "      # SERVER_TRUSTED_PROXIES: 172.17.0.1"]
        : []),
    '      # Behind a load balancer that learns from /up/ready that a container stops: answer a few more seconds.',
    "      SERVER_SHUTDOWN_DELAY_SECONDS: '0'",
    '    # SIGTERM → SERVER_SHUTDOWN_DELAY_SECONDS → drain (at most 10 s) — before Docker sends SIGKILL.',
    '    stop_grace_period: 20s',
  ];
  const services = [
    ...web,
    '',
    '  worker:',
    '    <<: *app',
    '    # A job past its timeout ends the worker with exit code 70 — the restart policy brings a fresh one.',
    '    # Every queue, fairly. For a priority, add a second worker with --queue=mail.',
    "    command: ['queue:work']",
    '    healthcheck:',
    '      disable: true',
    '    # SIGTERM: no new job; the running one gets --stop-timeout (10 s) to finish. Raise both together.',
    '    stop_grace_period: 30s',
    '',
    '  scheduler:',
    '    <<: *app',
    "    command: ['schedule:work']",
    '    healthcheck:',
    '      disable: true',
    '    # SIGTERM: no new run; the running ones get --stop-timeout (30 s), then their locks are freed (a hung one ends 10 s later).',
    '    stop_grace_period: 45s',
  ];
  if (proxied && proxy === 'caddy') {
    services.push(
      '',
      '  # TLS (certificates from Let\'s Encrypt), HTTP/2 and HTTP/3 — and live streams (SSE) unbuffered (deploy/Caddyfile).',
      '  caddy:',
      '    image: caddy:2',
      '    restart: unless-stopped',
      '    ports:',
      "      - '80:80'",
      "      - '443:443'",
      "      - '443:443/udp'",
      '    environment:',
      '      APP_DOMAIN: ${APP_DOMAIN:?set APP_DOMAIN to the domain of the app, e.g. example.com}',
      '    volumes:',
      '      - ./deploy/Caddyfile:/etc/caddy/Caddyfile:ro',
      '      - caddy_data:/data',
      '      - caddy_config:/config',
      '    depends_on:',
      '      - web',
    );
  }
  if (proxied && proxy === 'nginx') {
    services.push(
      '',
      '  # TLS with your certificates (deploy/certs), HTTP/2, live streams unbuffered (deploy/nginx.conf).',
      '  nginx:',
      '    image: nginx:mainline-alpine',
      '    restart: unless-stopped',
      '    ports:',
      "      - '80:80'",
      "      - '443:443'",
      '    volumes:',
      '      - ./deploy/nginx.conf:/etc/nginx/conf.d/default.conf:ro',
      '      - ./deploy/certs:/etc/nginx/certs:ro',
      '    depends_on:',
      '      - web',
    );
  }
  const volumes = ['  storage:', ...(proxied && proxy === 'caddy' ? ['  caddy_data:', '  caddy_config:'] : [])];
  return `# Written by \`marmeon make:docker\` — one image, a role per container: the web server, the queue worker, the scheduler.
#
#   docker compose -f compose.production.yaml up -d --build
#
# Configuration and secrets live in .env.production on the server (APP_KEY, APP_URL=https://…, DB_*, MAIL_DRIVER=smtp, …) —
# never a developer's .env. NODE_ENV=production comes from the image.
# More than one web container, or containers on more than one machine: sessions, cache and queue must not use the file or
# sqlite drivers (SESSION_DRIVER/CACHE_DRIVER=redis or database, QUEUE_DRIVER=redis or database on Postgres).

x-app: &app
  build: .
  image: ${app.name}
  # No \`init: true\`: the image's PID 1 is tini — it passes signals on and reaps orphans.
  restart: unless-stopped
  env_file: .env.production
  volumes:
    # One volume for every role on this machine: SQLite, file sessions and cache, uploads.
    - storage:/app/storage

services:
${services.join('\n')}

volumes:
${volumes.join('\n')}
`;
}

export function caddyfile({ systemd = false }: DockerOptions): string {
  const upstream = systemd ? '127.0.0.1:3000' : 'web:3000';
  return `# Written by \`marmeon make:docker --caddy\`. Caddy fetches the certificate for {$APP_DOMAIN} and speaks HTTP/1.1, HTTP/2 and
# HTTP/3: a browser opens at most 6 HTTP/1.1 connections per host, so live streams (SSE) in more tabs need HTTP/2.
# It sets X-Forwarded-For/-Proto/-Host itself (and drops a client's), which the app trusts from SERVER_TRUSTED_PROXIES.
# Trying it locally: APP_DOMAIN=localhost and a \`tls internal\` line in the block.
{$APP_DOMAIN} {
	# No \`encode\`: the assets arrive compressed (marmeon build writes .br/.gz), and documents stay uncompressed — a
	# compressed page that carries a secret (the CSRF token) is what BREACH reads.
	reverse_proxy ${upstream} {
		# Live streams: Caddy flushes text/event-stream by itself. On a config reload it ends them after this long (the tabs
		# reconnect anyway).
		stream_close_delay 5m
	}
}
`;
}

export function nginxConf({ systemd = false }: DockerOptions): string {
  const upstream = systemd ? '127.0.0.1:3000' : 'web:3000';
  // What both locations pass on: the request as nginx saw it, never what the client sent about it.
  const proxy = `		proxy_pass http://marmeon;
		proxy_http_version 1.1;
		proxy_set_header Connection "";
		proxy_set_header Host $host;
		# Set by nginx, never passed on: Proto, Host and For replace whatever the client sent — For is the address nginx
		# sees (with SERVER_TRUSTED_PROXIES: '*' the app takes the right-most entry anyway). Behind another proxy (a CDN), append
		# ($proxy_add_x_forwarded_for) and name both proxies' ranges in SERVER_TRUSTED_PROXIES instead of '*'.
		proxy_set_header X-Forwarded-For $remote_addr;
		proxy_set_header X-Forwarded-Proto $scheme;
		proxy_set_header X-Forwarded-Host $host;`;
  // The path is UPLOADS_PREFIX of @marmeon/storage, which the cli cannot import: keep both in step.
  const uploads = `	# Uploads to a local disk: the app limits each one to the size it announced, so nginx neither limits nor buffers the body.
	location ^~ /_marmeon/uploads/ {
		# The only route there is PUT /_marmeon/uploads/:id.
		limit_except PUT {
			deny all;
		}
		client_max_body_size 0;
		proxy_request_buffering off;
${proxy}
	}
`;
  return `# Written by \`marmeon make:docker --nginx\`. Replace example.com; the certificates (fullchain.pem, privkey.pem) are yours to
# provide — ${systemd ? 'e.g. from certbot' : 'deploy/certs is mounted at /etc/nginx/certs'}.
upstream marmeon {
	server ${upstream};
	keepalive 16;
	# Idle connections to the app close here first: the app keeps them longer (SERVER_KEEP_ALIVE_TIMEOUT_SECONDS, default 65 s) — the other
	# way round nginx would send a request on a connection the app is just closing (a 502 now and then).
	keepalive_timeout 60s;
}

server {
	listen 80;
	listen [::]:80;
	server_name example.com;
	return 301 https://$host$request_uri;
}

server {
	listen 443 ssl;
	listen [::]:443 ssl;
	# A browser opens at most 6 HTTP/1.1 connections per host — live streams (SSE) in more tabs need HTTP/2.
	http2 on;
	server_name example.com;
	ssl_certificate ${systemd ? '/etc/letsencrypt/live/example.com/fullchain.pem' : '/etc/nginx/certs/fullchain.pem'};
	ssl_certificate_key ${systemd ? '/etc/letsencrypt/live/example.com/privkey.pem' : '/etc/nginx/certs/privkey.pem'};
	# SERVER_MAX_BODY_MB of the app (default 8).
	client_max_body_size 8m;
	# No gzip for documents: a compressed page that carries a secret (the CSRF token) is what BREACH reads. The assets arrive
	# compressed already (marmeon build writes .br/.gz).
	gzip off;

${uploads}
	location / {
${proxy}
		# Live streams send a heartbeat every 20 s and X-Accel-Buffering: no (unbuffered): the timeout must be longer.
		proxy_read_timeout 75s;
	}
}
`;
}

/** The systemd units of the three roles — the app in /srv/<name>, run as the user <name>. */
export function systemdUnits(app: DockerApp): Record<'web' | 'worker' | 'scheduler', string> {
  // `key` names the unit file (deploy/systemd/<key>.service → <app>-<key>.service), `role` is what the comment calls it.
  const unit = (key: string, role: string, description: string, command: string, stop: number, extra: string[] = []) => `# Written by \`marmeon make:docker --systemd\`: the ${role} of ${app.name}. Copy to /etc/systemd/system/${app.name}-${key}.service, then
#   systemctl daemon-reload && systemctl enable --now ${app.name}-${key}
# The app lives in /srv/${app.name} (marmeon build and a production install done there), runs as the user ${app.name}, and reads
# its configuration from /etc/${app.name}/env (APP_KEY, APP_URL, DB_*, MAIL_DRIVER=smtp, … — chmod 600). Node must be on PATH.
[Unit]
Description=${app.name} ${description}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${app.name}
WorkingDirectory=/srv/${app.name}
EnvironmentFile=/etc/${app.name}/env
Environment=NODE_ENV=production
${extra.join('\n')}${extra.length ? '\n' : ''}ExecStart=/srv/${app.name}/node_modules/.bin/marmeon ${command}
Restart=always
RestartSec=1
# SIGTERM to the one Node process, then SIGKILL after:
KillSignal=SIGTERM
TimeoutStopSec=${stop}
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=/srv/${app.name}/storage

[Install]
WantedBy=multi-user.target
`;
  return {
    web: unit('web', 'web server', 'web server (marmeon start)', 'start', 30, [
      '# Only the proxy on this machine connects: listen on loopback, trust its X-Forwarded-*.',
      'Environment=HOST=127.0.0.1 PORT=3000 SERVER_TRUSTED_PROXIES=127.0.0.1',
      '# SIGTERM → SERVER_SHUTDOWN_DELAY_SECONDS → drain (at most 10 s): TimeoutStopSec covers both.',
    ]),
    worker: unit('worker', 'queue worker', 'queue worker (marmeon queue:work)', 'queue:work', 30, [
      '# Every queue, fairly. For a priority, a second unit with --queue=mail.',
      '# A job past its timeout ends the worker with exit code 70: Restart=always brings a fresh one. On SIGTERM the running',
      '# job gets --stop-timeout (10 s): TimeoutStopSec must be longer — raise both together for long jobs.',
    ]),
    scheduler: unit('scheduler', 'scheduler', 'scheduler (marmeon schedule:work)', 'schedule:work', 45, [
      '# On SIGTERM the running tasks get --stop-timeout (30 s), and a hung one ends the process 10 s later: TimeoutStopSec covers both.',
    ]),
  };
}

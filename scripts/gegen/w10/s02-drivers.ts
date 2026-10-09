import { defineGegenproben } from '../define.ts';

/**
 * W10.2 — the driver rule (E198): a package that wraps one third-party driver brings it (`@marmeon/redis` → `redis`, and the decided
 * exception `@marmeon/mail` → `nodemailer`); one of several drivers stays an optional peer whose error names the exact command with the
 * tested major (S3, `mjml`, `pg`); a library the app must share one instance of stays a peer (`@opentelemetry/api`).
 *
 * The starter kit proves the dependencies as an app meets them (`pack:smoke`, from the tarballs, nothing hoisted): the Redis drivers
 * without `redis` in the app (G1), SMTP from the production install (G3), an S3 default disk without the SDK fails the start (G2b).
 * Masking pair G1 ↔ G1b: an app that installs `redis` itself hides a missing dependency (X1, green) — so the smoke refuses a kit
 * that lists it (G1b). The scaffolder overrides only what gets installed: pnpm installs an overridden optional peer (G6).
 */
const smoke = { command: ['pnpm', 'run', 'pack:smoke'], timeout: 15 * 60_000 } as const;
const redisAsPeer = {
  file: 'packages/redis/package.json',
  find: '    "@marmeon/core": "workspace:*",\n    "redis": "^6.2.1"\n  }\n}',
  replace: '    "@marmeon/core": "workspace:*"\n  },\n  "peerDependencies": {\n    "redis": "^6.2.1"\n  },\n  "peerDependenciesMeta": {\n    "redis": {\n      "optional": true\n    }\n  }\n}',
};
const kitInstallsRedis = {
  file: 'scripts/pack-smoke.ts',
  find: "pnpmApp.run('pnpm', ['add', tarball('@marmeon/redis'), tarball('@marmeon/storage'), ...pnpmFlags",
  replace: "pnpmApp.run('pnpm', ['add', tarball('@marmeon/redis'), tarball('@marmeon/storage'), 'redis@^6.2.1', ...pnpmFlags",
};

export default defineGegenproben({
  step: 'W10.2',
  cases: [
    // --- One driver: a dependency (rule 1) ---------------------------------------------------------------------------------------
    {
      id: 'G1',
      title: 'redis back to an optional peer of @marmeon/redis: the kit on CACHE_DRIVER=redis cannot start — the app has no redis',
      patch: [redisAsPeer],
      run: smoke,
      expect: /marmeon start exited with 1:[\s\S]*Cannot find package 'redis' imported from/,
    },
    {
      id: 'X1',
      title: 'masking probe: the same, but the kit installs redis itself (and the smoke does not mind) — green, the app hides the missing dependency',
      patch: [redisAsPeer, kitInstallsRedis, { file: 'scripts/pack-smoke.ts', find: '      if (drivers.length > 0) throw new SmokeError', replace: '      if (drivers.length < 0) throw new SmokeError' }],
      run: smoke,
      expectGreen: true,
    },
    {
      id: 'G1b',
      title: 'the kit installs redis itself (the dependency in place): the smoke refuses it — what X1 shows would go unnoticed',
      patch: [kitInstallsRedis],
      run: smoke,
      expect: /the kit's package\.json lists redis — the driver step must show what @marmeon\/redis brings by itself/,
      masks: 'G1',
    },
    {
      id: 'G3',
      title: 'nodemailer back to an optional peer of @marmeon/mail: SMTP from the production install of the kit fails',
      patch: [
        { file: 'packages/mail/package.json', find: '    "nodemailer": "^10.0.13",\n    "valibot"', replace: '    "valibot"' },
        { file: 'packages/mail/package.json', find: '  "peerDependencies": {\n    "mjml"', replace: '  "peerDependencies": {\n    "nodemailer": "^10.0.13",\n    "mjml"' },
        { file: 'packages/mail/package.json', find: '  "peerDependenciesMeta": {\n', replace: '  "peerDependenciesMeta": {\n    "nodemailer": {\n      "optional": true\n    },\n' },
      ],
      run: smoke,
      expect: /SMTP from the production install failed[\s\S]*Cannot find package 'nodemailer'/,
    },
    // --- Several drivers: optional peers with the exact command (rule 2) ----------------------------------------------------------
    {
      id: 'G2',
      title: 'the S3 command without the major and without the presigner: the message test names the difference',
      patch: [{ file: 'packages/storage/src/drivers/s3.ts', find: "export const S3_INSTALL = 'pnpm add @aws-sdk/client-s3@^3 @aws-sdk/s3-request-presigner@^3';", replace: "export const S3_INSTALL = 'pnpm add @aws-sdk/client-s3';" }],
      run: { vitest: 'packages/storage/src/provider.test.ts', name: 'an S3 default disk (or UPLOADS_DISK) without the AWS SDK fails the start' },
      expect: /not installed in this app: pnpm add @aws-sdk\/client-s3: expected/,
    },
    {
      id: 'G2b',
      title: 'the start no longer checks the SDK of an S3 default disk (dist/, what pack:smoke packs): the kit comes up and fails later',
      patch: [{ file: 'packages/storage/dist/index.js', find: '        checkS3Sdk(options, uploads.disk);\n', replace: '' }],
      run: smoke,
      expect: /marmeon start came up with an S3 default disk and no AWS SDK — it should fail at the start/,
    },
    {
      id: 'G8',
      title: 'the mjml command without the major: the message test names the difference',
      patch: [{ file: 'packages/mail/src/mjml.ts', find: "export const MJML_INSTALL = 'pnpm add mjml@^5';", replace: "export const MJML_INSTALL = 'pnpm add mjml';" }],
      run: { vitest: 'packages/mail/src/mail.test.ts', name: 'without mjml (an optional peer, E198) says what to install' },
      expect: /not installed in this app: pnpm add mjml: expected/,
    },
    {
      id: 'G9',
      title: 'the pg command without the major: the message test names the difference',
      patch: [{ file: 'packages/database/src/postgres.ts', find: "export const PG_INSTALL = 'pnpm add pg@^8';", replace: "export const PG_INSTALL = 'pnpm add pg';" }],
      run: { vitest: 'packages/database/src/database.test.ts', name: 'without pg, DB_CONNECTION=pgsql says what to install' },
      expect: /not installed in this app: pnpm add pg: expected/,
    },
    // --- A shared instance: a peer (rule 3) ---------------------------------------------------------------------------------------
    {
      id: 'G4',
      title: '@opentelemetry/api as a dependency of @marmeon/otel: the driver rule refuses a second API instance',
      patch: [{ file: 'packages/otel/package.json', find: '  "dependencies": {\n    "@marmeon/core": "workspace:*"\n  },', replace: '  "dependencies": {\n    "@marmeon/core": "workspace:*",\n    "@opentelemetry/api": "^1.9.0"\n  },' }],
      run: { vitest: 'scripts/ci.test.ts', name: 'the driver rule (E198) > holds for every package' },
      expect: /@marmeon\/otel: @opentelemetry\/api must stay a peer, not a dependency \(E198\) — the app and the framework share one instance/,
    },
    // --- The scaffolder's overrides (what the smoke measures must be what a user installs) -----------------------------------------
    {
      id: 'G6',
      title: 'pnpm overrides for every tarball again: the optional peer @marmeon/redis is overridden — pnpm would install it (and redis) in every kit',
      patch: [{ file: 'packages/create-marmeon/src/template.ts', find: '    ...[...tarballs].filter(([dependency]) => installed.has(dependency)).map(', replace: '    ...[...tarballs].map(' }],
      run: { vitest: 'packages/create-marmeon/src/create.test.ts', name: 'vendors them into the app' },
      expect: /not to contain '@marmeon\/redis'/,
    },
  ],
});

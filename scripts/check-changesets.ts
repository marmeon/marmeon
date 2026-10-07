/**
 * `pnpm check-changesets` — the release rules (E152, E153, E157, E168), a part of `pnpm run ci`. Exit 1 names every broken rule.
 *
 *   1. **One fixed group** — `.changeset/config.json` has exactly one `fixed` group, and it covers every published package
 *      (`@marmeon/*`, `marmeon`, `create-marmeon`) and no private one; public access, `main`, private packages unversioned.
 *   2. **One version** — every published package has the same version (lockstep: the exact peers name it).
 *   3. **The changesets** — each names known, published packages with `patch`, `minor` or `major`; **no `major` below 1.0.0**:
 *      in 0.x a breaking change is a `minor` (with its UPGRADING.md entry) — Changesets would jump to 1.0.0.
 *   4. **The release workflow** — `.github/workflows/release.yml`: read-only by default, `id-token: write` only in the job that
 *      stages the packages, staged with pnpm (`pnpm stage publish` through `release:stage`) after `pack:check`, never `npm publish`,
 *      a plain `pnpm publish` or an npm token; the version pull request through Changesets; a GitHub-hosted runner.
 *   5. **`scripts/npm-trust.sh`** names every package (`node scripts/npm-trust.ts` writes it) and allows staged publishing only.
 *   6. **`UPGRADING.md`** has every entry of the list below, under its wave — the 22 hints of the Wave 7 acceptance, the Wave 6
 *      hints, the Wave 8 changes —, each with an impact and its likelihood, and no placeholder left.
 *   7. **The policies** — `LICENSE` (MIT, holder "BespokeCode", E153), `CONTRIBUTING.md` with the DCO sign-off, `SECURITY.md` with
 *      private vulnerability reporting, the deprecation policy in the root README.
 * Besides: actionlint over the workflows when it is installed (it is not on CI's runners — a note, never a failure).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { frameworkPackages, type FrameworkPackage } from './packages.ts';
import { trustScript, TRUST_SCRIPT } from './npm-trust.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

/** The entries UPGRADING.md must keep, by wave — GitHub's heading anchors. A reworded heading changes its anchor: update it here. */
export const UPGRADING_ANCHORS: Readonly<Record<'Wave 10' | 'Wave 9' | 'Wave 8' | 'Wave 7' | 'Wave 6', readonly string[]>> = {
  'Wave 10': [
    'medium-the-app-validates-with-rules--password-pagequery-upload-and-a-tables-query-are-rules-confirmed-of-marmeonauth-is-gone', // W10.4, E197
    'medium-queuework-takes-every-queue-fairly--a---queue-list-keeps-its-strict-order', // W10.5, E199
    'medium-the-frameworks-look-is-a-stylesheet--import-marmeonreactstylescss-layerdialogs-style-arrives-after-the-mount', // W10.7, E202
    'medium-accounts-without-a-confirmed-address-are-deleted-after-7-days--auth_unverified_days-authprune-unverified', // W10.8, E203
    'low-marmeonvalidation--laravels-rules-typed-standard-schema-stays-the-contract', // W10.3, E197
    'low-redis-comes-with-marmeonredis-nodemailer-with-marmeonmail--install-messages-name-the-major', // W10.2, E198
    'low-uploadsprune---hours-below-uploads_lifetime-needs---force', // W10.8, E204
    'low-what-a-failure-shows-loads-when-it-happens--the-dialog-of-a-5xx-and-the-error-pages-are-a-chunk-of-their-own', // W10.7, E202
    'low-a-session-draws-its-csrf-token-when-something-needs-it--a-guests-request-makes-none', // W10.8, E203
    'low-a-tables-and-an-inboxs-cursors-belong-to-their-list--name-in-cursoroptions', // W10.8, E204
    'low-staging-takes-the-production-branches-of-the-browser-code-and-of-server-rendering--short-codes-no-development-warnings', // W10.6, E201
    'low-the-mail-previews-answer-only-localhost-and-the-host-of-app_url--the-devtools-host-check-moved-to-marmeoncoredev', // W10.6, E200
    'low-a-callers-traceparent-is-a-link-of-the-requests-span--otel_trust_traceparenttrue-continues-its-trace', // W10.8, E205
    'low-a-url-in-a-log-context-is-masked-like-text--its-query-token-and-token-like-path-segments', // W10.8, E204
  ],
  'Wave 9': [
    'low-marmeon-build-needs-no-env-and-no-key--drop-the-throwaway-key-from-your-dockerfile', // W9.2, E187
    'low-the-image-runs-marmeon-under-tini--rebuild-it',
    'low-pnpm-1291',
    'low-a-new-apps-title-is-its-name-not-marmeon',
    'medium-an-actions-or-a-live-hints-reload-replaces-merged-props--a-deleted-row-stays-gone', // W9.3, E183
    'medium-paginate-takes-ctxquery--pagequery-in-the-query-schema-paginationfrom-deprecated',
    'medium-pagination-takes-its-links-from-the-parsed-query-and-its-texts-from-labels',
    'low-a-list-in-a-gets-data-is-the-key-repeated',
    'low-merge-of-a-paginator-appends-its-data-matchon-takes-paths-merge-marks-no-longer-pile-up',
    'low-cursors-are-encrypted--cursorpaginate-needs-the-encrypter-an-old-cursor-is-a-400',
    'medium-one-session-holds-at-most-16-live-streams-per-process--the-17th-tab-gets-a-429', // W9.4, E182
    'medium-a-cluster-marmeon-start-with-workers-needs-live_driverredis',
    'low-the-server-keeps-idle-connections-65-s-keep_alive_timeout',
    'medium-the-navigator-uses-the-navigation-api--historystate-is-null-its-navigate-events-are-visible', // W9.7, E184
    'low-the-guard-cancels-a-back-where-the-browser-lets-it--and-goes-back-by-the-browsers-key',
    'low-userouter-loads-the-pages-optimistic-patches-on-first-use',
    'low-the-starter-kit-asks-in-the-pages-language--its-own-confirm',
    'low-view-transitions-are-opt-in--with-viewtransition-react-a-page-change-is-a-react-transition', // W9.8, E185
    'medium-with-private-registration-a-change-of-address-is-pending-until-its-link-is-clicked--migrate-the-new-columns', // W9.9, E187
    'medium-the-registration-of-makeauth-is-private-by-default--auth_private_registrationfalse-turns-it-off', // E193
    'low-the-start-warns-when-another-program-holds-127001-at-its-port--and-a-taken-port-fails-startserver', // W9.10b
    'low-queries-on-a-shared-connection-take-turns--a-transactions-a-tests-pinned-one',
    'low-a-tables-filter-on-a-hidden-column-is-hidden-with-it',
    'low-a-reset-in-a-submits-onsuccessonfinish-resets-to-the-defaults-before-the-submit--the-saved-form-is-not-dirty',
    'low-a-page-that-builds-its-reloads-while-rendering-renders-on-the-server-again',
    'low-marmeon-dev-answers-other-origins-without-cors-headers',
    'low-an-s3-temporary-url-names-the-content-type-by-the-file-name',
    'low-a-private-s3-disk-that-shares-a-prefix-of-one-bucket-with-a-public-one-fails-the-start',
    'low-verified-treats-a-user-without-email_verified_at-as-unverified',
    'medium-smtp-requires-tls--starttls-or-no-mail-mail_require_tls', // E192
  ],
  'Wave 8': [
    'high-marmeon-is-a-dependency-of-the-app',
    'high-session-keys-are-hashed--every-user-is-signed-out-once-a-database-sessions-table-needs-its-upgrade-migration',
    'medium-protections-apply-to-every-node_env-but-development-and-test--staging-and-a-missing-node_env-included',
    'medium-node_env-falls-back-to-the-apps-env', // E170
    'medium-marmeon-start-respects-node_env',
    'medium-migrate-writes-the-table-types-with-node_envdevelopment-only',
    'medium-cookies-are-secure-when-app_url-is-https--every-cookie-of-the-request',
    'medium-behind-trusted_proxies-x-forwarded-proto-and--host-set-the-requests-url-ranges-are-allowed-typos-fail-the-start',
    'medium-csrf--the-browsers-word-first-a-request-from-another-site-is-403-not-419',
    'medium-a-guests-page-starts-no-session--pagecsrf-and-xsrf-token-only-with-a-session',
    'medium-a-session-written-by-two-requests-at-once-is-merged-not-overwritten--and-custom-stores-compare-versions',
    'medium-the-tabs-of-a-browser-follow-each-others-sign-in-sign-out-and-language--createmarmeonapp-loads-tab-sync',
    'medium-signing-out-clears-the-sites-storage-too--clear-site-data-cache-storage-clear-sitecache--is-clear-sitedata-',
    'low-session_encrypt-encrypts-the-session-data-in-its-store',
    'low-routeblock-runs-a-routes-requests-one-at-a-time-per-session',
    'low-marmeon-keygenerate---force-keeps-the-old-key-in-app_previous_keys',
    'low-csrf_trusted_origins-lists-origins--the-scheme-counts',
    'low-the-login-event-carries-the-requests-address-and-browser-by-itself--requestinfo',
    'low-marmeon-makeauth---private-registration-the-generated-forms-carry-no-_token',
    'low-one-process-for-marmeon-start-and-every-command',
    'low-one-discovery-manifest-per-condition-set-relative-paths-written-by-marmeon-build',
    'low-marmeon-build-precomputes-the-injection-lists--deploy-what-you-built',
    'low-marmeon-start-writes-nodes-compile-cache-to-storageframeworkcompile-cache',
    'low-oxc-parser-pino-pretty-and-the-tinker-repl-load-only-when-used',
    'low-environments-of-the-scheduler-counts-a-missing-node_env-as-production',
    'low-createtestapp-runs-as-node_envtest-unless-its-env-names-another',
    'low-the-packages-ship-their-sources-for-the-source-maps-and-a-license-each',
    'low-the-blank-app-has-a-envexample-and-a-storage-skeleton',
    'low-an-opt-in-content-security-policy-with-a-nonce-per-response--on-in-the-web-app-and-the-starters-shell',
    'low-assets-cached-a-year-and-sent-precompressed--marmeon-build-writes-br-and-gz',
    'low-host-chooses-the-interface-the-start-line-names-it-and-the-port-it-got',
    'low-the-development-error-page-and-the-mail-preview-bring-their-own-content-security-policy',
    'low-upready-answers-503-from-sigterm-on-and-keeps-a-result-for-a-second-shutdown_delay',
    'low-marmeon-start---workersn-and-marmeon-makedocker',
    'low-a-flash-message-stays-with-the-tab-that-flashed-it',
    'low-middleware-sets-the-headers-of-the-frameworks-responses-in-place--editableresponse',
    'low-middlewaregroupsget-and-routermiddlewarefor-return-the-same-frozen-list-until-a-group-changes',
    'low-the-encrypter-runs-on-nodecrypto--the-same-payloads-about-five-times-faster',
    'low-marmeon-makeauth-no-longer-maps--to-the-sign-in-page',
    'low-create-marmeon--the-blank-app-is-its---minimal-output-with-the-devtools-a-test-and-pnpm-test',
    'low-the-dev-server-pre-bundles-from-the-client-entry-and-the-pages',
    'low-one-version-for-every-package--010-from-npm',
    'medium-trusted_proxies-trusts-the-direct-peer-only--a-client-can-no-longer-choose-its-address', // W8.13, E172
    'low-a-guests-island-that-follows-a-live-channel-answers-without-the-subscription--not-500',
    'low-the-file-stores-break-a-stale-guard-one-waiter-at-a-time--withfileguard',
    'low-an-idle-worker-names-a-queue-nobody-takes',
    'low-port0-asks-the-system-for-a-free-port',
    'low-with---workersn-the-boots-warnings-come-once-from-the-primary',
    'low-marmeon-in-a-copy-under-node_modules-runs-its-dist-a-failed-start-names-nodes-error-code',
    'low-contributors-the-monorepo-needs-pnpm-12',
  ],
  // The 22 hints of the Wave 7 acceptance (W8 step 11), in their order there.
  'Wave 7': [
    'low-contributors-pnpm-run-ci-is-the-check-command--not-pnpm-ci', // 1
    'medium-development-features-run-with-node_envdevelopment-only--never-not-production', // 2 (E115; E139)
    'low-marmeon-dev-sets-node_envdevelopment-when-it-is-missing', // 3
    'low-ononeserver-and-withoutoverlapping-with-a-file-or-memory-cache-warn-instead-of-throwing', // 4 (E123)
    'low-the-schedulers-events--the-field-is-skipped', // 5 (E127)
    'low-diagnostics-channels-for-observing-the-framework', // 6
    'medium-up-and-upready-belong-to-the-framework', // 7 (E126)
    'low-createtestapp-turns-the-devtools-off-unless-asked', // 8
    'medium-shared-props-are-optional--layouts-must-cope-with-undefined', // 9
    'medium-discovery-follows-pnpm--an-app-discovers-only-what-it-installs', // 10
    'medium-client-code-imports-server-modules-with-import-type-only', // 11 (E121)
    'low-marmeon-makelint-config-and-the-lint-preset', // 12
    'low-redaction-reaches-into-lists-child-loggers-and-the-request-log-line', // 13 (E125)
    'low-html-raw-html-and-escapehtml-live-in-marmeoncore', // 14
    'low-the-devtools-are-a-package-of-their-own', // 15
    'low-opentelemetry--the-app-brings-the-sdk-as-dependencies', // 16 (E159)
    'low-a-defaulted-constructor-parameter-of-an-injectable-type-warns', // 17 (E128)
    'low-a-configerror-shows-its-solution-only-when-it-lists-variables', // 18
    'low-tinker-keeps-a-history--plain-text-and-a-banner-where-it-is-protected', // 19
    'high-every-app-needs-an-app_key', // 20
    'low-contributors-the-postgres-test-databases-are-dropped-after-a-test-run', // 21
    'medium-mail_mailerlog-writes-mail-texts-to-the-log--protected-environments-warn', // 22 (E135; E139)
  ],
  // From the queue README's "Upgrading from before Wave 6".
  'Wave 6': [
    'medium-an-event-with-a-queued-listener-needs-static-event-and-static-schema',
    'medium-createtestapp-fakes-the-queue-events-storage-and-notifications',
    'medium-mails-need-absolute-links',
    'low-the-login-event-carries-via-ip-and-useragent-and-can-be-queued',
    'low-queued-listeners-have-no-aftercommit-any-more',
    'low-custom-stores-implement-more',
    'low-constructors-that-take-a-clock-take-it-as-a-required-parameter',
  ],
};

/** GitHub's anchor for a heading: lower case, punctuation dropped (not `-` and `_`), every space a hyphen. */
export function slug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;

/** A glob of the Changesets config (`@marmeon/*`) as a test — `*` is any run of characters but `/`. */
function globTest(glob: string): (name: string) => boolean {
  const pattern = new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);
  return (name) => pattern.test(name);
}

/** Every workspace package (published or not): name → private. */
function workspacePackages(repository: string): Map<string, boolean> {
  const result = new Map<string, boolean>();
  for (const dir of ['packages', 'apps']) {
    const base = join(repository, dir);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const file = join(base, entry.name, 'package.json');
      if (!entry.isDirectory() || !existsSync(file)) continue;
      const manifest = readJson<{ name: string; private?: boolean }>(file);
      result.set(manifest.name, manifest.private === true);
    }
  }
  return result;
}

interface ChangesetConfig {
  fixed?: string[][];
  linked?: string[][];
  ignore?: string[];
  access?: string;
  baseBranch?: string;
  privatePackages?: boolean | { version?: boolean; tag?: boolean };
}

/** 1 · the fixed group, 2 · one version. */
export function checkGroup(repository: string, packages: readonly FrameworkPackage[]): string[] {
  const problems: string[] = [];
  const file = join(repository, '.changeset/config.json');
  if (!existsSync(file)) return ['.changeset/config.json is missing — the release needs Changesets (E152)'];
  const config = readJson<ChangesetConfig>(file);
  const published = packages.map((pkg) => pkg.name);
  const workspace = workspacePackages(repository);

  if (config.access !== 'public') problems.push(`.changeset/config.json: "access" is ${JSON.stringify(config.access)}, not "public"`);
  if (config.baseBranch !== 'main') problems.push(`.changeset/config.json: "baseBranch" is ${JSON.stringify(config.baseBranch)}, not "main"`);
  const privateVersioned = typeof config.privatePackages === 'boolean' ? config.privatePackages : config.privatePackages?.version === true;
  if (privateVersioned) problems.push('.changeset/config.json: private packages (the apps, the monorepo) must not be versioned — "privatePackages": { "version": false }');
  if ((config.linked ?? []).length > 0) problems.push('.changeset/config.json: "linked" groups — the framework is one fixed group, nothing is linked');
  const ignored = published.filter((name) => (config.ignore ?? []).some((glob) => globTest(glob)(name)));
  if (ignored.length > 0) problems.push(`.changeset/config.json: "ignore" leaves out ${ignored.join(', ')} — every package is released`);

  const groups = config.fixed ?? [];
  if (groups.length !== 1) {
    problems.push(`.changeset/config.json: ${groups.length} "fixed" groups — exactly one holds every package (lockstep, E152)`);
  } else {
    const tests = groups[0]!.map(globTest);
    const inGroup = (name: string) => tests.some((test) => test(name));
    const outside = published.filter((name) => !inGroup(name));
    if (outside.length > 0) {
      problems.push(`${outside.join(', ')} ${outside.length === 1 ? 'is' : 'are'} outside the fixed group of .changeset/config.json — every published package shares one version (E152)`);
    }
    for (const glob of groups[0]!) {
      if (![...workspace.keys()].some(globTest(glob))) problems.push(`.changeset/config.json: the fixed group's "${glob}" matches no package`);
    }
  }

  const versions = new Map<string, string[]>();
  for (const pkg of packages) versions.set(pkg.manifest.version, [...(versions.get(pkg.manifest.version) ?? []), pkg.name]);
  if (versions.size > 1) {
    const listed = [...versions].map(([version, names]) => `${version}: ${names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ')}`);
    problems.push(`the packages have ${versions.size} versions (${listed.join('; ')}) — one version for all (pnpm changeset version)`);
  }
  return problems;
}

/** 3 · the changeset files. */
export function checkChangesets(repository: string, packages: readonly FrameworkPackage[]): string[] {
  const problems: string[] = [];
  const dir = join(repository, '.changeset');
  if (!existsSync(dir)) return problems;
  const versions = new Map(packages.map((pkg) => [pkg.name, pkg.manifest.version]));
  const workspace = workspacePackages(repository);
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.md') && name !== 'README.md').sort()) {
    const text = readFileSync(join(dir, file), 'utf8');
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (!front) {
      problems.push(`.changeset/${file} has no front matter (---) naming packages and bumps`);
      continue;
    }
    for (const line of front[1]!.split(/\r?\n/).filter((entry) => entry.trim() !== '')) {
      const entry = /^\s*["']?([^"':]+)["']?\s*:\s*(\w+)\s*$/.exec(line);
      if (!entry) {
        problems.push(`.changeset/${file}: "${line.trim()}" is no "package": bump line`);
        continue;
      }
      const [, name, bump] = entry as unknown as [string, string, string];
      const version = versions.get(name);
      if (version === undefined) {
        problems.push(`.changeset/${file}: ${name} is ${workspace.has(name) ? 'private — it is never released' : 'no package of the repository'}`);
        continue;
      }
      if (!['patch', 'minor', 'major'].includes(bump)) problems.push(`.changeset/${file}: ${name} has the bump "${bump}" — patch, minor or major`);
      if (bump === 'major' && Number(version.split('.')[0]) < 1) {
        problems.push(
          `.changeset/${file}: "${name}": major below 1.0.0 (now ${version}) — Changesets would jump to 1.0.0. In 0.x a breaking change is a minor, with its entry in UPGRADING.md (E152).`,
        );
      }
    }
  }
  return problems;
}

/** The jobs of a workflow file: name → its lines (the YAML is simple enough to cut at the two-space job keys). */
function jobsOf(workflow: string): Map<string, string> {
  const jobs = new Map<string, string>();
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (start < 0) return jobs;
  let current: string | undefined;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const job = /^ {2}([\w-]+):\s*$/.exec(line);
    if (job) {
      current = job[1]!;
      jobs.set(current, '');
    } else if (current !== undefined) jobs.set(current, `${jobs.get(current)}${line}\n`);
  }
  return jobs;
}

/** 4 · the release workflow. */
export function checkWorkflow(repository: string): string[] {
  const file = join(repository, '.github/workflows/release.yml');
  if (!existsSync(file)) return ['.github/workflows/release.yml is missing (E152)'];
  const problems: string[] = [];
  const workflow = readFileSync(file, 'utf8');
  const code = workflow.replace(/(^|\s)#.*$/gm, '$1'); // comments say what must not happen — read only the YAML
  const where = 'release.yml';

  if (!/^permissions:\s*\n\s+contents:\s*read\s*$/m.test(code)) problems.push(`${where}: the workflow's default "permissions:" must be "contents: read" — each job asks for what it needs`);
  if (/\bnpm\s+publish\b/.test(code)) problems.push(`${where}: "npm publish" — npm ignores publishConfig.exports and ships the @marmeon/source condition; pnpm stages the packages`);
  if (/NPM_TOKEN|NODE_AUTH_TOKEN|_authToken|registry-url:/.test(code)) problems.push(`${where}: an npm token or registry-url — trusted publishing (OIDC) needs no token, and none may sit in the repository`);
  if (/\bpnpm\s+(?:-r\s+|--recursive\s+)?publish\b/.test(code)) problems.push(`${where}: a plain "pnpm publish" — every release is staged (pnpm stage publish) and waits for a maintainer's 2FA approval (E152)`);
  if (!/changesets\/action\/version@v2/.test(code)) problems.push(`${where}: the version pull request comes from changesets/action/version@v2`);

  const jobs = jobsOf(code);
  const staging = [...jobs].filter(([, body]) => /release:stage|pnpm\s+stage\s+publish/.test(body));
  if (staging.length !== 1) problems.push(`${where}: ${staging.length} jobs stage the packages (pnpm run release:stage) — exactly one`);
  for (const [name, body] of jobs) {
    const oidc = /^\s+id-token:\s*write\s*$/m.test(body);
    const stages = staging.some(([job]) => job === name);
    if (stages && !oidc) problems.push(`${where}: the job "${name}" stages the packages without "id-token: write" — trusted publishing and provenance need the OIDC token`);
    if (!stages && oidc) problems.push(`${where}: the job "${name}" has "id-token: write" but stages nothing — only the staging job gets the OIDC token`);
    if (stages) {
      if (!/runs-on:\s*ubuntu-latest/.test(body)) problems.push(`${where}: the job "${name}" must run on a GitHub-hosted runner (ubuntu-latest) — trusted publishing needs one`);
      const check = body.search(/pnpm run ci --only [\w:,-]*pack:check/);
      const stage = body.search(/release:stage|pnpm\s+stage\s+publish/);
      if (check < 0 || check > stage) problems.push(`${where}: the job "${name}" runs pack:check before it stages the packages`);
    }
  }
  const manifest = readJson<{ scripts?: Record<string, string> }>(join(repository, 'package.json'));
  const stageScript = manifest.scripts?.['release:stage'] ?? '';
  if (!/^pnpm stage publish (?:-r|--recursive)\b/.test(stageScript)) problems.push(`package.json: "release:stage" is "${stageScript}" — pnpm stage publish -r (staged, with pnpm)`);
  return problems;
}

/** 5 · `scripts/npm-trust.sh`. */
export function checkTrust(repository: string): string[] {
  const file = join(repository, TRUST_SCRIPT);
  if (!existsSync(file) || readFileSync(file, 'utf8') !== trustScript(repository)) return [`${TRUST_SCRIPT} is missing or out of date — node scripts/npm-trust.ts`];
  if (/--allow-publish\b/.test(readFileSync(file, 'utf8'))) return [`${TRUST_SCRIPT} allows direct publishing — staged only (--allow-stage-publish)`];
  return [];
}

/** 6 · `UPGRADING.md`. */
export function checkUpgrading(repository: string, anchors: typeof UPGRADING_ANCHORS = UPGRADING_ANCHORS): string[] {
  const file = join(repository, 'UPGRADING.md');
  if (!existsSync(file)) return ['UPGRADING.md is missing (E168)'];
  const problems: string[] = [];
  const text = readFileSync(file, 'utf8');
  const entries = new Map<string, { wave: string; body: string }>();
  let wave = '';
  let current: string | undefined;
  for (const line of text.split('\n')) {
    const heading = /^(#{2,4}) (.+)$/.exec(line);
    if (heading?.[1] === '###') wave = heading[2]!;
    if (heading) {
      current = heading[1] === '####' ? slug(heading[2]!) : undefined;
      if (current !== undefined) {
        if (entries.has(current)) problems.push(`UPGRADING.md: two entries have the anchor #${current}`);
        entries.set(current, { wave, body: '' });
        if (!/^#### (High|Medium|Low)( \(contributors\))?: /.test(line)) problems.push(`UPGRADING.md: "${line}" — an entry starts with its impact (High:, Medium:, Low:)`);
      }
    } else if (current !== undefined) entries.get(current)!.body += `${line}\n`;
  }
  for (const [name, list] of Object.entries(anchors)) {
    list.forEach((anchor, index) => {
      const entry = entries.get(anchor);
      const label = name === 'Wave 7' ? `the Wave 7 hint ${index + 1}` : `a ${name} entry`;
      if (!entry) problems.push(`UPGRADING.md lacks ${label}: #${anchor}`);
      else if (!entry.wave.startsWith(name)) problems.push(`UPGRADING.md: #${anchor} (${label}) is under "${entry.wave}", not "${name}"`);
    });
  }
  for (const [anchor, entry] of entries) {
    if (!/\*Likelihood of impact: (high|medium|low)\b/.test(entry.body)) problems.push(`UPGRADING.md: #${anchor} does not say its likelihood of impact`);
  }
  if (/Collected in W8 step 11|<!--/.test(text)) problems.push('UPGRADING.md still has a placeholder or a comment');
  return problems;
}

/** 7 · licence and policies. */
export function checkPolicies(repository: string): string[] {
  const problems: string[] = [];
  const read = (file: string) => (existsSync(join(repository, file)) ? readFileSync(join(repository, file), 'utf8') : undefined);
  const license = read('LICENSE');
  if (!license?.startsWith('MIT License') || !/^Copyright \(c\) \d{4}(?:-\d{4})? BespokeCode\b/m.test(license)) {
    problems.push('LICENSE: MIT with "Copyright (c) <year> BespokeCode" (E153 — the exact company name is for Max to confirm)');
  }
  const contributing = read('CONTRIBUTING.md');
  if (!contributing || !/Developer Certificate of Origin/.test(contributing) || !/Signed-off-by:/.test(contributing) || !/git commit -s\b/.test(contributing)) {
    problems.push('CONTRIBUTING.md: the DCO — "Developer Certificate of Origin", the Signed-off-by line, git commit -s (E153)');
  }
  const security = read('SECURITY.md');
  if (!security || !/private\s+vulnerability\s+reporting/i.test(security)) problems.push('SECURITY.md: reports go through GitHub private vulnerability reporting (E168)');
  const readme = read('README.md');
  if (!readme || !/^## Versions and deprecations$/m.test(readme)) problems.push('README.md: the deprecation policy, "## Versions and deprecations" (E168)');
  return problems;
}

function actionlint(repository: string): string | undefined {
  const result = spawnSync('actionlint', [], { cwd: repository, encoding: 'utf8' });
  if (result.error) return undefined;
  return result.status === 0 ? '' : (result.stdout + result.stderr).trim();
}

export function check(repository: string = root): string[] {
  const packages = frameworkPackages(repository);
  return [
    ...checkGroup(repository, packages),
    ...checkChangesets(repository, packages),
    ...checkWorkflow(repository),
    ...checkTrust(repository),
    ...checkUpgrading(repository),
    ...checkPolicies(repository),
  ];
}

if (import.meta.main) {
  const problems = check();
  const lint = actionlint(root);
  if (lint) problems.push(`actionlint:\n${lint.replace(/^/gm, '    ')}`);
  const packages = frameworkPackages(root);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`✗ ${problem}`);
    console.error(`\ncheck-changesets: ${problems.length} problem${problems.length === 1 ? '' : 's'}.`);
    process.exitCode = 1;
  } else {
    const upgrading = Object.values(UPGRADING_ANCHORS).reduce((sum, list) => sum + list.length, 0);
    console.log(
      `check-changesets: ${packages.length} packages at ${packages[0]?.manifest.version} in one fixed group, the changesets, release.yml, ` +
        `npm-trust.sh, ${upgrading} UPGRADING entries and the policies are in order${lint === undefined ? ' (actionlint not installed — skipped)' : ', actionlint clean'}.`,
    );
  }
}

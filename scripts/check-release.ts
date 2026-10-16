/**
 * `pnpm check-release` — the release rules, a part of `pnpm run ci`. Exit 1 names every broken rule: one version across the
 * published packages (and `workspace:*` between them), their changelogs (the top section is the version, the same in every package
 * after 0.1.2), `.github/workflows/release.yml` (read-only by default; the build job packs and hashes the tarballs after
 * `pack:check` without an OIDC token; `id-token: write` only in the job that stages them, which checks out and installs nothing and
 * verifies the hashes before `npm stage publish`; never `npm publish`, a plain `pnpm publish` or an npm token; a
 * GitHub Release only as a draft, and the draft is there), `scripts/npm-trust.sh` (staged publishing only), the policies (LICENSE, DCO,
 * SECURITY.md, the deprecation policy) and `UPGRADING.md` bound to the packages' version ({@link UPGRADING_ANCHORS}),
 * `.github/workflows/pr-label.yml` (the release label check, token-free) and `.github/release.yml` (what the release rules
 * generate). Besides: actionlint over the workflows when it is installed (a note, never a failure).
 *
 * Each rule in full: CONTRIBUTING.md, "Pull requests and releases".
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { frameworkPackages, type FrameworkPackage } from './packages.ts';
import { trustScript, TRUST_SCRIPT, ENVIRONMENT } from './npm-trust.ts';
import { CATEGORIES, compareVersions, fromLine, isBreakingRelease, parseChangelog, parseVersion, RELEASE_CONFIG, releaseConfigCurrent, releaseSection, upgradesFrom } from './release-rules.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

/**
 * The entries UPGRADING.md must keep, by release — the version of its section (`## Upgrading to 0.2.0 from 0.1.0` → `'0.2.0'`) to
 * GitHub's anchors of its entries (`#### Medium: …`). A reworded heading changes its anchor: update it here.
 *
 * Empty until the first entry: no release has needed one yet, and the page says so. The requirement switches on by
 * itself — the first `## Upgrading to …` section of UPGRADING.md is refused until its entries are listed here, and from then on every
 * listed entry must stand under its release.
 */
export const UPGRADING_ANCHORS: Readonly<Record<string, readonly string[]>> = {
  '0.2.0': [
    'high-every-route-has-to-say-who-may-call-it',
    'medium-authattempt-and-authlogin-can-wait-for-a-second-factor',
    'low-a-custom-remembertokenstore-has-to-return-createdat',
    'low-loginvia-has-a-fourth-member-passkey',
  ],
};

/** `gh release create` stays a draft: `--draft` or `--draft=true`. gh reads the last flag and any value but `true` may mean false. */
const DRAFT = /\s--draft(?:=true)?(?=\s|$)/;
const NOT_DRAFT = /\s--draft=(?!true(?=\s|$))/;

/** A release's section: `## Upgrading to <version> from <version>`. Steps (`### …`) inside it keep the release as the section. */
const RELEASE_SECTION = /^## Upgrading to (\d+\.\d+\.\d+) from (\d+\.\d+\.\d+)\s*$/;

/** GitHub's anchor for a heading: lower case, punctuation dropped (not `-` and `_`), every space a hyphen. */
export function slug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** Up to this version the changelog sections were written per package and differ; from the next version on every package has the same one. */
export const CHANGESETS_UNTIL = '0.1.2';

/** The dependency fields in which a published package names another one only as `workspace:*`. */
const DEPENDENCY_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'] as const;

/** 1 · one version, and the internal ranges that carry it. */
export function checkVersion(_repository: string, packages: readonly FrameworkPackage[]): string[] {
  const problems: string[] = [];
  const versions = new Map<string, string[]>();
  for (const pkg of packages) versions.set(pkg.manifest.version, [...(versions.get(pkg.manifest.version) ?? []), pkg.name]);
  if (versions.size > 1) {
    const listed = [...versions].map(([version, names]) => `${version}: ${names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ')}`);
    problems.push(`the packages have ${versions.size} versions (${listed.join('; ')}) — one version for all (pnpm release:prepare)`);
  }
  const published = new Set(packages.map((pkg) => pkg.name));
  for (const pkg of packages) {
    for (const field of DEPENDENCY_FIELDS) {
      const dependencies = (pkg.manifest[field] ?? {}) as Record<string, string>;
      for (const [name, range] of Object.entries(dependencies)) {
        if (published.has(name) && range !== 'workspace:*') {
          problems.push(`${pkg.name}: ${field}["${name}"] is "${range}" — a framework package depends on another with "workspace:*", so the release version reaches it`);
        }
      }
    }
  }
  return problems;
}

/** 2 · the changelogs: every published package has one, its top section is the version, and from the release after {@link CHANGESETS_UNTIL} on the section is the same everywhere. */
export function checkChangelogs(repository: string, packages: readonly FrameworkPackage[]): string[] {
  const problems: string[] = [];
  const version = packages[0]?.manifest.version;
  for (const pkg of packages) {
    const file = join(pkg.dir, 'CHANGELOG.md');
    const where = `${pkg.name}: packages/${pkg.short}/CHANGELOG.md`;
    if (!existsSync(file)) {
      problems.push(`${where} is missing`);
      continue;
    }
    try {
      const top = parseChangelog(readFileSync(file, 'utf8')).sections[0]?.version;
      if (top !== pkg.manifest.version) problems.push(`${where}: its first section is ${top === undefined ? 'missing' : `"## ${top}"`}, but the package is at ${pkg.manifest.version} — pnpm release:prepare writes it`);
    } catch (error) {
      problems.push(`${where}: ${(error as Error).message}`);
    }
  }
  if (problems.length === 0 && version !== undefined && parseVersion(version) && compareVersions(version, CHANGESETS_UNTIL) > 0) {
    try {
      releaseSection(repository, version);
    } catch (error) {
      problems.push((error as Error).message);
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

/** The steps of a job: its `steps:` list cut at the `- ` items. */
export function stepsOf(job: string): string[] {
  const lines = job.split('\n');
  const start = lines.findIndex((line) => /^\s+steps:\s*$/.test(line));
  if (start < 0) return [];
  const item = /^(\s*)- /.exec(lines.slice(start + 1).find((line) => /^\s*- /.test(line)) ?? '');
  if (!item) return [];
  const steps: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith(`${item[1]}- `)) steps.push(`${line}\n`);
    else if (steps.length > 0) steps[steps.length - 1] += `${line}\n`;
  }
  return steps;
}

/** The scripts of every `run:` in a text — inline or a block scalar (the lines indented deeper than the key). */
export function runScripts(text: string): string[] {
  const lines = text.split('\n');
  const scripts: string[] = [];
  for (const [index, line] of lines.entries()) {
    const key = /^(\s*)(?:- )?run:\s*(.*)$/.exec(line);
    if (!key) continue;
    const indent = key[1]!.length + (line.trimStart().startsWith('- ') ? 2 : 0);
    if (!/^[|>][+-]?\d?$/.test(key[2]!.trim())) {
      scripts.push(key[2]!);
      continue;
    }
    const body: string[] = [];
    for (const next of lines.slice(index + 1)) {
      if (next.trim() !== '' && next.length - next.trimStart().length <= indent) break;
      body.push(next);
    }
    scripts.push(body.join('\n'));
  }
  return scripts;
}

/** The events under `on:` — `undefined` when `on:` is not a block (`on: push`, `on: [push]`). */
function eventsOf(workflow: string): string[] | undefined {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => line.startsWith('on:'));
  if (start < 0 || !/^on:\s*$/.test(lines[start]!)) return undefined;
  const events: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const event = /^ {2}([\w-]+):/.exec(line);
    if (event) events.push(event[1]!);
  }
  return events;
}

/** After the checkout of the release commit nothing may move the tree: a second checkout, a switch, a reset, a pull, a merge. */
const MOVES_THE_TREE = /(?<![\w-])git\s+(?:-\S+\s+(?:\S+\s+)?)*(?:checkout|switch|reset|restore|pull|merge|rebase|cherry-pick|worktree|stash|read-tree|apply|am)\b/;

/** 4 · the release workflow. */
export function checkWorkflow(repository: string): string[] {
  const file = join(repository, '.github/workflows/release.yml');
  if (!existsSync(file)) return ['.github/workflows/release.yml is missing'];
  const problems: string[] = [];
  const workflow = readFileSync(file, 'utf8');
  const code = workflow.replace(/(^|\s)#.*$/gm, '$1'); // comments say what must not happen — read only the YAML
  const where = 'release.yml';

  // Exactly "contents: read": a scope added here (id-token: write) would reach every job, the build job that runs the repository's code too.
  if (!/^permissions:[ \t]*\n[ \t]+contents:[ \t]*read[ \t]*\n(?=\S|$)/m.test(code)) problems.push(`${where}: the workflow's default "permissions:" must be exactly "contents: read" — each job asks for what it needs`);
  if (/^env:/m.test(code)) problems.push(`${where}: an env: for the whole workflow — every job, the staging one too, would inherit it; set variables on the step that needs them`);
  if (/\bnpm\s+publish\b/.test(code)) problems.push(`${where}: "npm publish" — npm ignores publishConfig.exports and ships the @marmeon/source condition; pnpm packs the packages and npm stages the tarballs`);
  if (/NPM_TOKEN|NODE_AUTH_TOKEN|_authToken|registry-url:/.test(code)) problems.push(`${where}: an npm token or registry-url — trusted publishing (OIDC) needs no token, and none may sit in the repository`);
  if (/\bpnpm\s+(?:-r\s+|--recursive\s+)?publish\b/.test(code)) problems.push(`${where}: a plain "pnpm publish" — every release is staged (npm stage publish) and waits for a maintainer's 2FA approval`);
  if (/\bpnpm\s+(?:run\s+)?(?:-r\s+|--recursive\s+)?stage\b|\brelease:stage\b/.test(code)) problems.push(`${where}: pnpm stage or release:stage — pnpm would run in the job that holds the OIDC token; the tarballs the build job packed are staged with "npm stage publish"`);
  // A command may continue on the next line (`\`): join them before looking for the flag.
  const joined = (text: string) => text.replace(/\\\r?\n/g, ' ');
  for (const line of joined(code).split('\n')) {
    if (/\bgh\s+release\s+create\b/.test(line) && (!DRAFT.test(line) || NOT_DRAFT.test(line))) {
      problems.push(`${where}: "${line.trim()}" creates a public GitHub Release — only a draft (--draft): the maintainer publishes it after approving on npm`);
    }
    if (/\bgh\s+release\s+edit\b/.test(line) && NOT_DRAFT.test(line)) problems.push(`${where}: "${line.trim()}" publishes a GitHub Release — only the maintainer does, by hand`);
  }
  if (/["']?\buses["']?\s*:\s*\S*(?:create-release|action-gh-release)\b/.test(code)) problems.push(`${where}: a release action — the release is drafted with "gh release create --draft"`);
  const events = eventsOf(code);
  if (events?.join() !== 'workflow_dispatch') {
    problems.push(`${where}: "on:" holds ${events === undefined ? 'no block of events' : events.join(', ') || 'nothing'} — only workflow_dispatch: a release is started by hand, by someone with write access`);
  }
  if (/\bsecrets\b/.test(code)) problems.push(`${where}: a secret — the release needs none (the write token is github.token, the staging uses OIDC)`);
  if (/^\s*(?:- )?cache:|\bactions\/cache\b/m.test(code)) problems.push(`${where}: a cache — a store another workflow wrote could carry code into the job that holds the OIDC token`);
  // setup-node restores a pnpm store by itself when package.json names pnpm (`package-manager-cache` defaults to true), without any `cache:` key.
  for (const chunk of code.split(/^(?=\s*- )/m)) {
    if (!/^\s*(?:- )?["']?uses["']?\s*:\s*actions\/setup-node@/m.test(chunk)) continue;
    const withBlock = /^(\s*)with:\s*\n((?:\1\s+\S.*(?:\n|$))*)/m.exec(chunk)?.[2] ?? '';
    if (!/^\s*package-manager-cache:\s*false\s*$/m.test(withBlock)) problems.push(`${where}: an actions/setup-node step without "package-manager-cache: false" under "with:" — the action restores a package-manager cache by default`);
  }
  if (/^\s*defaults:/m.test(code) || /^\s*(?:- )?shell:/m.test(code)) problems.push(`${where}: "defaults:" or "shell:" — a step runs in the runner's own bash, with the flags every script here relies on`);
  if (/^\s*(?:if|continue-on-error):|^\s*- (?:if|continue-on-error):/m.test(code)) problems.push(`${where}: an "if:" or "continue-on-error:" — no step may be skipped or fail silently`);
  for (const [, action] of code.matchAll(/["']?\buses["']?\s*:\s*["']?([^\s"']+)/g)) {
    if (!/@[0-9a-f]{40}$/.test(action!)) problems.push(`${where}: "${action}" is not pinned to a commit — every action is pinned by its full SHA, a moved tag must not change a job that holds a token`);
  }
  for (const script of runScripts(code)) {
    if (/(?<!\|)\|(?!\|)/.test(script.replace(/^\s*#.*$/gm, '')) && !/^\s*set -o pipefail\s*$/.test(script.trim().split('\n')[0] ?? '')) {
      problems.push(`${where}: a run script with a pipe ("${script.trim().split('\n')[0]}") must start with "set -o pipefail" — else a failing git ls-remote | cut reads as success and the step goes on to tag`);
    }
    if (script.includes('${{')) problems.push(`${where}: an expression inside a run script ("${script.trim().split('\n')[0]}") — pass it through env:, a branch name could inject commands`);
  }
  for (const line of joined(code).split('\n')) {
    for (const command of line.split(/;|&&|\|\||\|/)) {
      if (/(?<![\w-])git\s[^\n]*\bpush\b/.test(command) && !/\bpush origin "refs\/tags\/v\$VERSION"\s*$/.test(command.trim())) {
        problems.push(`${where}: "${command.trim()}" — a push is only the release's tag: git push origin "refs/tags/v$VERSION"`);
      }
    }
    if (/\bgh\s+api\b/.test(line)) problems.push(`${where}: "${line.trim()}" calls gh api — the release is drafted with "gh release create --draft", nothing else talks to the API`);
  }

  const jobs = jobsOf(code);
  /** The jobs another job waits for: `needs: a`, `needs: [a, b]`. */
  const needsOf = (body: string) =>
    (/^\s+needs:\s*(.+?)\s*$/m.exec(body)?.[1] ?? '')
      .replace(/[[\]]/g, '')
      .split(',')
      .map((job) => job.trim())
      .filter((job) => job !== '');
  const staging = [...jobs].filter(([, body]) => /\bnpm\s+stage\s+publish\b/.test(body));
  if (staging.length !== 1) problems.push(`${where}: ${staging.length} jobs stage the packages (npm stage publish) — exactly one`);
  const stagingName = staging[0]?.[0];
  const building = stagingName === undefined ? [] : needsOf(jobs.get(stagingName)!);
  if (stagingName !== undefined && (building.length !== 1 || !jobs.has(building[0]!))) {
    problems.push(`${where}: the staging job waits for ${building.length === 1 ? `"${building[0]}", which is no job` : `${building.length} jobs`} — for exactly one, the build job that packs and hashes the tarballs ("needs: build")`);
  }
  const buildName = building.length === 1 && jobs.has(building[0]!) ? building[0] : undefined;
  const releasing = [...jobs].filter(([name, body]) => stagingName !== undefined && name !== stagingName && needsOf(body).includes(stagingName));
  if (releasing.length !== 1) problems.push(`${where}: ${releasing.length} jobs run after the staging job ("needs: ${stagingName}") — exactly one tags and drafts the release`);
  const releaseName = releasing[0]?.[0];
  if (releaseName !== undefined && buildName !== undefined && !needsOf(jobs.get(releaseName)!).includes(buildName)) {
    problems.push(`${where}: the job "${releaseName}" waits for the build job too ("needs: [${buildName}, ${stagingName}]") — the commit, version and latest flag are its outputs`);
  }
  const needs = (key: string) => `needs.${buildName}.outputs.${key}`;
  /** `KEY: ${{ source }}` in a step's env. */
  const env = (step: string, key: string, source: string) => new RegExp(`^\\s*${key}:\\s*\\$\\{\\{\\s*${source.replace(/\./g, '\\.')}\\s*\\}\\}\\s*$`, 'm').test(step);
  const checkoutOf = (step: string) => /["']?\buses["']?\s*:\s*actions\/checkout\b/.test(step);
  const usesOf = (step: string) => /^\s*(?:- )?["']?uses["']?\s*:\s*(\S+)/m.exec(step)?.[1];
  /** The lines of a step's scripts, trimmed, without the empty ones. */
  const linesOf = (step: string) => runScripts(step).join('\n').split('\n').map((line) => line.trim()).filter((line) => line !== '');
  /** The artifact the build job uploads and the staging job downloads: its name and where it lies. */
  const ARTIFACT = { name: 'tarballs', path: '${{ runner.temp }}/tarballs' };
  const artifactWith = (step: string) => new RegExp(`^\\s*name:\\s*${ARTIFACT.name}\\s*$`, 'm').test(step) && new RegExp(`^\\s*path:\\s*${ARTIFACT.path.replace(/[$.{}]/g, '\\$&')}\\s*$`, 'm').test(step);

  for (const [name, body] of jobs) {
    if (!/^ {4}permissions:\s*$/m.test(body)) problems.push(`${where}: the job "${name}" has no "permissions:" block of its own — a job states what it needs, none inherits a scope`);
    const stages = name === stagingName;
    const builds = name === buildName;
    const releases = name === releaseName;
    const oidc = /^\s+id-token:\s*write\s*$/m.test(body);
    const environment = /^ {4}environment:\s*["']?([\w.-]+)["']?\s*(#.*)?$/m.exec(body)?.[1];
    if (stages && environment !== ENVIRONMENT) problems.push(`${where}: the job "${name}" stages without "environment: ${ENVIRONMENT}" — npm trusts the staging only from that environment, whose branch policy keeps other branches out`);
    if (!stages && /^ {4}environment:/m.test(body)) problems.push(`${where}: the job "${name}" has an "environment:" — only the staging job enters ${ENVIRONMENT}`);
    if (stages && !oidc) problems.push(`${where}: the job "${name}" stages the packages without "id-token: write" — trusted publishing and provenance need the OIDC token`);
    if (!stages && oidc) problems.push(`${where}: the job "${name}" has "id-token: write" but stages nothing — only the staging job gets the OIDC token`);
    for (const [, scope] of body.matchAll(/^\s+([\w-]+):\s*write\b/gm)) {
      if (!stages && !releases) problems.push(`${where}: the job "${name}" asks for "${scope}: write" — only the staging job (id-token) and the job after it (contents) may write`);
      else if (scope === 'contents' && !releases) problems.push(`${where}: the job "${name}" asks for "contents: write" — only the job after the staging, which installs nothing, may write contents`);
      else if (scope !== 'contents' && scope !== 'id-token') problems.push(`${where}: the job "${name}" asks for "${scope}: write" — a release needs contents (tag, draft) and id-token (staging) only`);
    }
    const steps = stepsOf(body);
    for (const step of steps) {
      if (checkoutOf(step) && !/^\s*persist-credentials:\s*false\s*$/m.test(step)) {
        problems.push(`${where}: the job "${name}" checks out without "persist-credentials: false" — else the token sits in .git/config for every script that follows`);
      }
    }
    const find = (test: RegExp) => steps.findIndex((step) => runScripts(step).some((script) => test.test(joined(script))));
    if (!releases && (find(/(?<![\w-])git\s[^\n]*\btag\b/) >= 0 || find(/\bgh\s+release\b/) >= 0)) {
      problems.push(`${where}: the job "${name}" tags or drafts the release — only the job after the staging does`);
    }
    if (stages) {
      if (!/runs-on:\s*ubuntu-latest/.test(body)) problems.push(`${where}: the job "${name}" must run on a GitHub-hosted runner (ubuntu-latest) — trusted publishing needs one`);
      // The OIDC token meets no code of the repository or of its dependencies: nothing is checked out, installed or built here.
      if (steps.some(checkoutOf)) problems.push(`${where}: the job "${name}" checks out the repository — it holds the OIDC token and stages the build job's tarballs, nothing else`);
      for (const step of steps) {
        const action = usesOf(step);
        if (action !== undefined && !action.startsWith('actions/download-artifact@') && !action.startsWith('actions/setup-node@') && !checkoutOf(step)) {
          problems.push(`${where}: the job "${name}" uses ${action} — besides the download of the artifact only actions/setup-node: this job holds the OIDC token`);
        }
        for (const script of runScripts(step)) {
          if (/(?<![\w./$-])(?:pnpm|npx|yarn|corepack|bun|deno|node|git)\b|\bnpm\b(?!\s+stage\s+publish\b)/.test(joined(script).replace(/^\s*#.*$/gm, ''))) {
            problems.push(`${where}: the job "${name}" runs "${script.trim().split('\n')[0]}" — it holds the OIDC token: no pnpm, node, git or install, only the hash checks and npm stage publish`);
          }
        }
      }
      const [download, setup, stage] = steps;
      if (steps.length !== 3 || !usesOf(download ?? '')?.startsWith('actions/download-artifact@') || !usesOf(setup ?? '')?.startsWith('actions/setup-node@') || usesOf(stage ?? '') !== undefined || runScripts(stage ?? '').length !== 1) {
        problems.push(`${where}: the job "${name}" has exactly three steps — the download of the artifact, actions/setup-node, the staging: it holds the OIDC token and runs nothing else`);
      }
      if (download !== undefined && !artifactWith(download)) problems.push(`${where}: the job "${name}" downloads the artifact "${ARTIFACT.name}" to ${ARTIFACT.path} — the one the build job uploads`);
      const nodeVersion = /^\s*node-version:\s*(\S+)\s*$/m.exec(setup ?? '')?.[1];
      const nvmrc = existsSync(join(repository, '.nvmrc')) ? readFileSync(join(repository, '.nvmrc'), 'utf8').trim() : undefined;
      if (nodeVersion === undefined || (nvmrc !== undefined && nodeVersion !== nvmrc)) {
        problems.push(`${where}: the job "${name}" sets up Node with "node-version: ${nvmrc ?? '<the version of .nvmrc>'}" — the job has no checkout to read .nvmrc from, so the version is written out and kept the Node that built the tarballs`);
      }
      const wanted = [
        'set -o pipefail',
        '[[ "$DIST_TAG" =~ ^latest(-[0-9]+(\\.[0-9]+)?)?$ ]]',
        'mkdir "$RUNNER_TEMP/empty"',
        'cd "$TARBALLS"',
        "printf '%s  SHA512SUMS\\n' \"$SUMS\" | sha512sum --check --strict -",
        'sha512sum --check --strict SHA512SUMS',
        // Nothing but SHA512SUMS and the files it names, dotfiles and directories included: npm would read a planted .npmrc.
        "expected=$( { echo ./SHA512SUMS; awk '{ print \"./\" $2 }' SHA512SUMS; } | sort )",
        'found=$(find . -mindepth 1 | sort)',
        'test "$expected" = "$found"',
        'cat SHA512SUMS',
        'cd "$RUNNER_TEMP/empty"',
        'while read -r _ name; do',
        'test "${name%-"$VERSION".tgz}" != "$name"',
        'npm stage publish "$TARBALLS/$name" --provenance --access public --tag="$DIST_TAG" < /dev/null',
        'done < "$TARBALLS/SHA512SUMS"',
      ];
      if (stage !== undefined && linesOf(stage).join('\n') !== wanted.join('\n')) {
        problems.push(`${where}: the job "${name}" stages with exactly ${wanted.map((line) => `\`${line}\``).join(', ')} — the hash of SHA512SUMS and of every tarball is checked before the first npm stage publish, and only the files SHA512SUMS names are staged with the build job's dist-tag`);
      }
      if (stage !== undefined && (!env(stage, 'SUMS', needs('sums')) || !env(stage, 'VERSION', needs('version')) || !env(stage, 'DIST_TAG', needs('dist-tag')) || !/^\s*TARBALLS:\s*\$\{\{\s*runner\.temp\s*\}\}\/tarballs\s*$/m.test(stage))) {
        problems.push(`${where}: the job "${name}" takes SUMS, VERSION and DIST_TAG of the staging from the build job's outputs (${needs('sums')}, .version, .dist-tag)`);
      }
      // The environment of the one step that runs npm: these variables and no other (NODE_OPTIONS, a proxy or a registry would reach the token).
      const envKeys = [...(/^(\s*)env:\s*\n((?:\1\s+\S.*(?:\n|$))*)/m.exec(stage ?? '')?.[2] ?? '').matchAll(/^\s*([\w-]+):/gm)].map((match) => match[1]!).sort();
      const allowed = ['DIST_TAG', 'NPM_CONFIG_GLOBALCONFIG', 'NPM_CONFIG_USERCONFIG', 'SUMS', 'TARBALLS', 'VERSION'];
      if (stage !== undefined && (envKeys.join() !== allowed.join() || !/^\s*NPM_CONFIG_USERCONFIG:\s*\$\{\{\s*runner\.temp\s*\}\}\/no-userconfig\s*$/m.test(stage) || !/^\s*NPM_CONFIG_GLOBALCONFIG:\s*\$\{\{\s*runner\.temp\s*\}\}\/no-globalconfig\s*$/m.test(stage))) {
        problems.push(`${where}: the job "${name}" stages with the env ${allowed.join(', ')} and no other (NPM_CONFIG_USERCONFIG and NPM_CONFIG_GLOBALCONFIG are two different files that do not exist, \${{ runner.temp }}/no-userconfig and /no-globalconfig; npm refuses one file for both) — npm reads its settings, a proxy and a registry among them, from the environment and from npmrc files`);
      }
      if ((body.match(/^\s*env:/gm) ?? []).length !== 1) problems.push(`${where}: the job "${name}" has an env: besides the one of the staging step — a job or other step could set NODE_OPTIONS or a proxy for npm`);
    }
    if (builds) {
      for (const key of ['commit', 'version', 'latest', 'dist-tag']) {
        if (!new RegExp(`^\\s+outputs:\\s*\\n(?:\\s+\\w[\\w-]*:.*\\n)*?\\s+${key}:\\s*\\$\\{\\{\\s*steps\\.guard\\.outputs\\.${key}\\s*\\}\\}\\s*$`, 'm').test(body)) {
          problems.push(`${where}: the job "${name}" hands the guard's "${key}" on as an output (steps.guard.outputs.${key}) — the staging and the release job work on it`);
        }
      }
      if (!new RegExp(`^\\s+outputs:\\s*\\n(?:\\s+\\w[\\w-]*:.*\\n)*?\\s+sums:\\s*\\$\\{\\{\\s*steps\\.pack\\.outputs\\.sums\\s*\\}\\}\\s*$`, 'm').test(body)) {
        problems.push(`${where}: the job "${name}" hands the hash of SHA512SUMS on as the output "sums" (steps.pack.outputs.sums) — the staging job checks the tarballs against it`);
      }
      const guard = steps.findIndex((step) => runScripts(step).some((script) => script.trim() === 'node scripts/release-guard.ts') && /^\s*(?:- )?id:\s*guard\s*$/m.test(step));
      const [install, check, pack] = [/\bpnpm\s+install\b/, /pnpm run ci --only [\w:,-]*pack:check/, /\bnode scripts\/release-pack\.ts\b/].map(find) as [number, number, number];
      if (guard < 0) {
        problems.push(`${where}: the job "${name}" has no step "node scripts/release-guard.ts" with the id "guard" — it picks the release commit and refuses a version that is tagged or on npm`);
      } else {
        const order = [['pnpm install', install], ['pack:check', check], ['packing', pack]] as const;
        let before = guard;
        let from = 'the guard';
        for (const [what, index] of order) {
          if (index < 0 || index < before) problems.push(`${where}: the job "${name}" ${what} must come after ${from} — in this order: guard, install, pack:check, packing`);
          before = Math.max(before, index);
          from = what;
        }
        if (steps.slice(0, guard).some((step) => runScripts(step).length > 0)) {
          problems.push(`${where}: the job "${name}" runs a script before the guard — the guard comes first (only actions before it): scripts of the branch would run unchecked`);
        }
        for (const [index, step] of steps.slice(guard + 1).entries()) {
          const last = guard + 1 + index === steps.length - 1;
          const action = usesOf(step);
          if (checkoutOf(step) || runScripts(step).some((script) => joined(script).split('\n').some((line) => MOVES_THE_TREE.test(line)))) {
            problems.push(`${where}: the job "${name}" checks out or moves the tree after the guard — the release commit stays the tree that is built, packed and tagged`);
          } else if (action !== undefined && !(last && action.startsWith('actions/upload-artifact@'))) {
            problems.push(`${where}: the job "${name}" uses an action after the guard — only run steps, and the upload of the artifact as the last step: an action could switch the tree or run code of its own`);
          }
        }
        const checkout = steps.slice(0, guard).find(checkoutOf);
        if (!checkout || !/^\s*fetch-depth:\s*0\s*$/m.test(checkout)) problems.push(`${where}: the job "${name}" checks out with "fetch-depth: 0" before the guard — the guard needs the history to find the release commit`);
        const packStep = steps[pack] ?? '';
        const wanted = ['test "$(git rev-parse HEAD)" = "$COMMIT"', 'status=$(git status --porcelain)', 'test -z "$status"', 'node scripts/release-pack.ts "$RUNNER_TEMP/tarballs"'];
        if (pack >= 0 && linesOf(packStep).join('\n') !== wanted.join('\n')) {
          problems.push(`${where}: the job "${name}" packs with exactly ${wanted.map((line) => `\`${line}\``).join(', ')} — the tree is still the release commit and clean`);
        }
        if (pack >= 0 && (!/^\s*(?:- )?id:\s*pack\s*$/m.test(packStep) || !env(packStep, 'COMMIT', 'steps.guard.outputs.commit'))) {
          problems.push(`${where}: the job "${name}" packs in the step with the id "pack" and takes COMMIT of it from the guard's output (steps.guard.outputs.commit)`);
        }
        const upload = steps.at(-1) ?? '';
        if (!usesOf(upload)?.startsWith('actions/upload-artifact@') || !artifactWith(upload) || !/^\s*retention-days:\s*1\s*$/m.test(upload)) {
          problems.push(`${where}: the job "${name}" ends by uploading the artifact "${ARTIFACT.name}" from ${ARTIFACT.path} with "retention-days: 1" — the staging job downloads it`);
        }
      }
      if (!/pnpm run ci --only [\w:,-]*pack:check/.test(joined(body))) problems.push(`${where}: the job "${name}" runs pack:check before the tarballs are packed for staging`);
      if (!/pnpm run ci --only [\w:,-]*\bcheck-release\b/.test(joined(body))) problems.push(`${where}: the job "${name}" runs check-release before the tarballs are packed for staging — the checks of the workflow and the version run on the release commit`);
    }
    if (releases) {
      if (!/^\s+contents:\s*write\s*$/m.test(body)) problems.push(`${where}: the job "${name}" needs "contents: write" for the tag and the draft`);
      const first = steps[0] ?? '';
      if (!checkoutOf(first) || !new RegExp(`^\\s*ref:\\s*\\$\\{\\{\\s*${needs('commit').replace(/\./g, '\\.')}\\s*\\}\\}\\s*$`, 'm').test(first)) {
        problems.push(`${where}: the job "${name}" starts by checking out the release commit (ref: \${{ ${needs('commit')} }}) — the guard's, not the branch head`);
      }
      for (const [index, step] of steps.entries()) {
        if (index === 0) continue;
        const uses = /^\s*(?:- )?["']?uses["']?\s*:\s*(\S+)/m.exec(step)?.[1];
        if (uses !== undefined && (!uses.startsWith('actions/setup-node@') || /^\s*cache:/m.test(step))) {
          problems.push(`${where}: the job "${name}" uses ${uses} — besides the checkout only actions/setup-node (without a cache): this job holds the write token`);
        }
        if (runScripts(step).some((script) => /\bpnpm\s+(?:install|i|add|exec|dlx)\b|\bnpm\b|\bnpx\b|\byarn\b/.test(script))) {
          problems.push(`${where}: the job "${name}" installs or runs a package — it holds the write token and runs nothing but the release script`);
        }
        if (runScripts(step).some((script) => joined(script).split('\n').some((line) => MOVES_THE_TREE.test(line)))) {
          problems.push(`${where}: the job "${name}" moves the tree — it tags the release commit it checked out`);
        }
      }
      const tag = find(/(?<![\w-])git\s[^\n]*\btag\b/);
      const draft = find(/\bgh\s+release\s+create\b/);
      if (tag >= 0 && draft >= 0 && (steps.length !== 4 || tag !== 2 || draft !== 3 || !/["']?\buses["']?\s*:\s*actions\/setup-node@/.test(steps[1] ?? ''))) {
        problems.push(`${where}: the job "${name}" has exactly four steps — the checkout, actions/setup-node, the tag, the draft: it holds the write token and runs nothing else`);
      }
      if (tag < 0 || draft < 0 || draft < tag) problems.push(`${where}: the job "${name}" tags the release commit, then drafts the GitHub release (gh release create … --draft)`);
      const tagStep = steps[tag] ?? '';
      const tagLines = runScripts(tagStep).map((script) => joined(script)).join('\n');
      if (tag >= 0) {
        if (!/^\s*test "\$\(git rev-parse HEAD\)" = "\$COMMIT"\s*$/m.test(tagLines)) problems.push(`${where}: the job "${name}" asserts that HEAD is "$COMMIT" before it tags`);
        if (!/\btag\b[^\n]*"\$COMMIT"/.test(tagLines) || !env(tagStep, 'COMMIT', needs('commit')) || !env(tagStep, 'VERSION', needs('version'))) {
          problems.push(`${where}: the job "${name}" tags "$COMMIT" from the build job's output (${needs('commit')}) — the release commit, not whatever the branch head is`);
        }
        if (!/^\s*existing=\$\(git ls-remote origin "refs\/tags\/v\$VERSION\^\{\}" \| cut -f1\)\s*$/m.test(tagLines) || !/^\s*elif \[ "\$existing" = "\$COMMIT" \]; then\s*$/m.test(tagLines) || !/^\s*exit 1\s*$/m.test(tagLines)) {
          problems.push(`${where}: the job "${name}" looks for a tag that exists (git ls-remote origin "refs/tags/v$VERSION^{}") and skips tagging only when it is "$COMMIT" — a re-run after a failed draft must not push again, and another commit's tag must fail`);
        }
        if (!/::add-mask::\$encoded/.test(tagLines)) problems.push(`${where}: the job "${name}" masks the encoded token (echo "::add-mask::$encoded") before it uses it in a push`);
      }
      const draftStep = steps[draft] ?? '';
      const draftLine = runScripts(draftStep).map((script) => joined(script)).join('\n').split('\n').find((line) => /\bgh\s+release\s+create\b/.test(line)) ?? '';
      if (draft >= 0) {
        if (!/\s--verify-tag(?=\s|$)/.test(draftLine) || /\s--target\b/.test(draftLine)) problems.push(`${where}: the job "${name}" drafts with --verify-tag and without --target — the draft belongs to the tag on the release commit`);
        if (!/\s--latest="\$LATEST"/.test(draftLine) || !env(draftStep, 'LATEST', needs('latest'))) {
          problems.push(`${where}: the job "${name}" drafts with --latest="$LATEST" from the build job's output (${needs('latest')}) — a late fix of an older line is not the latest release`);
        }
        if (!DRAFT.test(draftLine)) problems.push(`${where}: the job "${name}" drafts the GitHub release (gh release create … --draft)`);
      }
      // The write token reaches the tag and the draft step only — not another step, not the job's or the workflow's env.
      const rest = [tagStep, draftStep].reduce((text, step) => (step === '' ? text : text.replace(step.trimEnd(), '')), code);
      if (tag >= 0 && draft >= 0 && /github\.token/.test(rest)) {
        problems.push(`${where}: github.token outside the release job's tag and draft steps — no other step, no job or workflow env gets the write token`);
      }
    }
  }
  if (releaseName === undefined && /github\.token/.test(code)) problems.push(`${where}: github.token without a release job — only the tag and draft steps after the staging get it`);
  return problems;
}

/** 5 · `scripts/npm-trust.sh`. */
export function checkTrust(repository: string): string[] {
  const file = join(repository, TRUST_SCRIPT);
  if (existsSync(file) && !new RegExp(`--environment ${ENVIRONMENT}\\b`).test(readFileSync(file, 'utf8'))) return [`${TRUST_SCRIPT} does not pass --environment ${ENVIRONMENT} — a trust without the environment accepts the staging from any branch`];
  if (!existsSync(file) || readFileSync(file, 'utf8') !== trustScript(repository)) return [`${TRUST_SCRIPT} is missing or out of date — node scripts/npm-trust.ts`];
  if (/--allow-publish\b/.test(readFileSync(file, 'utf8'))) return [`${TRUST_SCRIPT} allows direct publishing — staged only (--allow-stage-publish)`];
  return [];
}

/**
 * 6 · `UPGRADING.md`: nothing before the first release; from then on every listed entry under its release. With the packages'
 * `version` the sections are bound to it: none above it, and a breaking release ({@link isBreakingRelease}) needs its section,
 * from a version of the line below, with its entries listed.
 */
export function checkUpgrading(repository: string, anchors: typeof UPGRADING_ANCHORS = UPGRADING_ANCHORS, version?: string): string[] {
  const file = join(repository, 'UPGRADING.md');
  if (!existsSync(file)) return ['UPGRADING.md is missing'];
  const problems: string[] = [];
  if (version !== undefined && !parseVersion(version)) {
    problems.push(`the packages are at ${version} — prerelease versions are not supported by this check: the sections of UPGRADING.md cannot be bound to them`);
    version = undefined;
  }
  const text = readFileSync(file, 'utf8');
  /** Entry anchor → the release it stands under (`undefined`: before any release section) and its text. */
  const entries = new Map<string, { release: string | undefined; body: string }>();
  const releases = new Map<string, string>();
  let release: string | undefined;
  let current: string | undefined;
  for (const line of text.split('\n')) {
    const heading = /^(#{1,4}) (.+)$/.exec(line);
    if (!heading) {
      if (current !== undefined) entries.get(current)!.body += `${line}\n`;
      continue;
    }
    const section = RELEASE_SECTION.exec(line);
    if (/^upgrading\s+(to|from)\b/i.test(heading[2]!) && !(heading[1] === '#' && heading[2] === 'Upgrading') && !section) {
      problems.push(`UPGRADING.md: "${line}" — a release's section is headed exactly "## Upgrading to <x.y.z> from <x.y.z>"`);
    }
    if (heading[1]!.length <= 2) {
      release = section?.[1];
      if (section) {
        const [, to, from] = section as unknown as [string, string, string];
        releases.set(to, from);
        if (!parseVersion(to) || !parseVersion(from)) problems.push(`UPGRADING.md: "${line}" — "## Upgrading to <x.y.z> from <x.y.z>", plain versions`);
        else {
          if (compareVersions(to, from) <= 0) problems.push(`UPGRADING.md: "${line}" — a release upgrades from a lower version to a higher one`);
          if (version !== undefined && compareVersions(to, version) > 0) problems.push(`UPGRADING.md has a section for ${to}, but the packages are at ${version}`);
        }
      }
    }
    current = heading[1] === '####' ? slug(heading[2]!) : undefined;
    if (current === undefined) continue;
    if (entries.has(current)) problems.push(`UPGRADING.md: two entries have the anchor #${current}`);
    entries.set(current, { release, body: '' });
    if (!/^#### (High|Medium|Low)( \(contributors\))?: /.test(line)) problems.push(`UPGRADING.md: "${line}" — an entry starts with its impact (High:, Medium:, Low:)`);
    if (release === undefined) {
      problems.push(`UPGRADING.md: #${current} stands under no release — an entry goes under its "## Upgrading to <version> from <version>"`);
    }
  }
  for (const released of releases.keys()) {
    if (!(released in anchors)) {
      problems.push(`UPGRADING.md has the section of ${released}, and scripts/check-release.ts lists none of its entries — add their anchors to UPGRADING_ANCHORS["${released}"]`);
    }
  }
  if (version !== undefined && isBreakingRelease(version)) {
    const from = releases.get(version);
    const heading = `## Upgrading to ${version} from <a ${fromLine(version)} version>`;
    if (from === undefined) problems.push(`${version} is a breaking release — UPGRADING.md needs its section "${heading}"`);
    else if (!upgradesFrom(version, from)) problems.push(`UPGRADING.md: the section of ${version} upgrades from ${from}, but it starts from ${fromLine(version)} — "${heading}"`);
    else if (version in anchors && anchors[version]!.length === 0) {
      problems.push(`${version} is a breaking release — scripts/check-release.ts lists none of its entries: UPGRADING_ANCHORS["${version}"]`);
    }
  }
  for (const [version, list] of Object.entries(anchors)) {
    if (!releases.has(version)) problems.push(`UPGRADING.md has no section "## Upgrading to ${version} from …", which scripts/check-release.ts lists`);
    for (const anchor of list) {
      const entry = entries.get(anchor);
      if (!entry) problems.push(`UPGRADING.md lacks an entry of ${version}: #${anchor}`);
      else if (entry.release !== undefined && entry.release !== version) problems.push(`UPGRADING.md: #${anchor} (an entry of ${version}) is under ${entry.release}`);
    }
  }
  for (const [anchor, entry] of entries) {
    if (!/\*Likelihood of impact: (high|medium|low)\b/.test(entry.body)) problems.push(`UPGRADING.md: #${anchor} does not say its likelihood of impact`);
  }
  if (/<!--/.test(text)) problems.push('UPGRADING.md still has a placeholder or a comment');
  return problems;
}

/** The label check's events: only the one that gives a fork's code no token, on every change of the commits or the labels. */
const LABEL_EVENT_TYPES = ['opened', 'reopened', 'synchronize', 'labeled', 'unlabeled'];

/** ci.yml: every action pinned by its full commit SHA, so a moved tag changes no job. */
export function checkCiWorkflow(repository: string): string[] {
  const file = join(repository, '.github/workflows/ci.yml');
  if (!existsSync(file)) return ['.github/workflows/ci.yml is missing'];
  const code = readFileSync(file, 'utf8').replace(/(^|\s)#.*$/gm, '$1');
  const problems: string[] = [];
  for (const [, action] of code.matchAll(/["']?\buses["']?\s*:\s*["']?([^\s"']+)/g)) {
    if (!/@[0-9a-f]{40}$/.test(action!)) problems.push(`ci.yml: "${action}" is not pinned to a commit — every action is pinned by its full SHA`);
  }
  return problems;
}

/** The pull request label check: its shape (it runs untrusted code, so it holds no token) and the label list. */
export function checkLabelWorkflow(repository: string): string[] {
  const where = 'pr-label.yml';
  const file = join(repository, '.github/workflows/pr-label.yml');
  if (!existsSync(file)) return [`${where}: .github/workflows/pr-label.yml is missing`];
  const problems: string[] = [];
  const code = readFileSync(file, 'utf8').replace(/(^|\s)#.*$/gm, '$1');

  const events = eventsOf(code);
  if (events?.join() !== 'pull_request') {
    problems.push(`${where}: "on:" must be exactly the pull_request event (found ${events?.join(', ') || 'no event block'}) — pull_request_target and every other event would hand a fork's code a token`);
  }
  const types = /^ {4}types:\s*\[([^\]]*)\]\s*$/m.exec(code)?.[1]?.split(',').map((type) => type.trim());
  if (!types || types.slice().sort().join() !== LABEL_EVENT_TYPES.slice().sort().join()) {
    problems.push(`${where}: the pull_request types must be [${LABEL_EVENT_TYPES.join(', ')}] — the check has to follow every push and every label change`);
  }
  if (!/^permissions:\s*\{\}\s*$/m.test(code)) problems.push(`${where}: the workflow's "permissions:" must be "{}" — the labels are in the event, the job needs no token`);
  if (/^[ \t]+permissions:/m.test(code)) problems.push(`${where}: a job asks for permissions — it needs none`);
  if (/["']?\buses["']?\s*:/.test(code)) problems.push(`${where}: a "uses:" step (a checkout or an action) — the check runs on untrusted pull requests and needs neither`);
  if (/\bsecrets\b|\bgithub\s*(?:\.\s*token\b|\[\s*['"]token)|GITHUB_TOKEN/.test(code)) problems.push(`${where}: a secret or the token — the check must hold none`);
  for (const script of runScripts(code)) {
    if (script.includes('${{')) problems.push(`${where}: an expression inside a run script ("${script.trim().split('\n')[0]}") — pass it through env:, a label name could inject commands`);
  }
  if (!/^\s+name:\s*release label\s*$/m.test(code)) problems.push(`${where}: the job must be named "release label" — that name is the required status check of the ruleset`);
  if (!/^\s+LABELS:\s*\$\{\{\s*toJSON\(github\.event\.pull_request\.labels\.\*\.name\)\s*\}\}\s*$/m.test(code)) {
    problems.push(`${where}: LABELS must be "\${{ toJSON(github.event.pull_request.labels.*.name) }}" in env`);
  }
  const errorLine = runScripts(code).flatMap((script) => script.split('\n')).find((line) => line.includes('::error')) ?? '';
  for (const { label } of CATEGORIES) {
    if (!new RegExp(`\\b${label} \\(`).test(errorLine)) problems.push(`${where}: the ::error message does not explain the label "${label}" (as "${label} (…)")`);
  }
  const wanted = CATEGORIES.map((category) => category.label).join(' ');
  const listed = /^\s+CATEGORIES:\s*(.*?)\s*$/m.exec(code)?.[1];
  if (listed !== wanted) problems.push(`${where}: CATEGORIES is "${listed ?? ''}", release-rules.ts has "${wanted}" — one list, in the same order`);
  return problems;
}

/** `.github/release.yml` is what the release rules generate. */
export function checkReleaseConfig(repository: string): string[] {
  return releaseConfigCurrent(repository) ? [] : [`${RELEASE_CONFIG}: missing or out of date — run node scripts/release-rules.ts`];
}

/** 7 · licence and policies. */
export function checkPolicies(repository: string): string[] {
  const problems: string[] = [];
  const read = (file: string) => (existsSync(join(repository, file)) ? readFileSync(join(repository, file), 'utf8') : undefined);
  const license = read('LICENSE');
  if (!license?.startsWith('MIT License') || !/^Copyright \(c\) \d{4}(?:-\d{4})? BespokeCode\b/m.test(license)) {
    problems.push('LICENSE: MIT with "Copyright (c) <year> BespokeCode"');
  }
  const contributing = read('CONTRIBUTING.md');
  if (!contributing || !/Developer Certificate of Origin/.test(contributing) || !/Signed-off-by:/.test(contributing) || !/git commit -s\b/.test(contributing)) {
    problems.push('CONTRIBUTING.md: the DCO — "Developer Certificate of Origin", the Signed-off-by line, git commit -s');
  }
  const security = read('SECURITY.md');
  if (!security || !/private\s+vulnerability\s+reporting/i.test(security)) problems.push('SECURITY.md: reports go through GitHub private vulnerability reporting');
  const readme = read('README.md');
  if (!readme || !/^## Versions and deprecations$/m.test(readme)) problems.push('README.md: the deprecation policy, "## Versions and deprecations"');
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
    ...checkVersion(repository, packages),
    ...checkChangelogs(repository, packages),
    ...checkWorkflow(repository),
    ...checkCiWorkflow(repository),
    ...checkLabelWorkflow(repository),
    ...checkReleaseConfig(repository),
    ...checkTrust(repository),
    ...checkUpgrading(repository, UPGRADING_ANCHORS, packages[0]?.manifest.version),
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
    console.error(`\ncheck-release: ${problems.length} problem${problems.length === 1 ? '' : 's'}.`);
    process.exitCode = 1;
  } else {
    const upgrading = Object.values(UPGRADING_ANCHORS).reduce((sum, list) => sum + list.length, 0);
    const guide = Object.keys(UPGRADING_ANCHORS).length === 0 ? 'UPGRADING.md (no entry yet)' : `${upgrading} UPGRADING entries`;
    console.log(
      `check-release: ${packages.length} packages at ${packages[0]?.manifest.version}, their changelogs, release.yml, pr-label.yml, .github/release.yml, ` +
        `npm-trust.sh, ${guide} and the policies are in order${lint === undefined ? ' (actionlint not installed — skipped)' : ', actionlint clean'}.`,
    );
  }
}

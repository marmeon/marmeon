/**
 * `pnpm check-changesets` — the release rules (E152, E153, E157, E168), a part of `pnpm run ci`. Exit 1 names every broken rule.
 *
 *   1. **One fixed group** — `.changeset/config.json` has exactly one `fixed` group, and it covers every published package
 *      (`@marmeon/*`, `marmeon`, `create-marmeon`) and no private one; public access, `main`, private packages unversioned.
 *   2. **One version** — every published package has the same version (lockstep: the exact peers name it).
 *   3. **The changesets** — each names known, published packages with `patch`, `minor` or `major`; **no `major` below 1.0.0**:
 *      in 0.x a breaking change is a `minor` (with its UPGRADING.md entry once there was a release) — Changesets would jump to 1.0.0.
 *   4. **The release workflow** — `.github/workflows/release.yml`: read-only by default, `id-token: write` only in the job that
 *      stages the packages, staged with pnpm (`pnpm stage publish` through `release:stage`) after `pack:check`, never `npm publish`,
 *      a plain `pnpm publish` or an npm token; the version pull request through Changesets; a GitHub-hosted runner.
 *   5. **`scripts/npm-trust.sh`** names every package (`node scripts/npm-trust.ts` writes it) and allows staged publishing only.
 *   6. **`UPGRADING.md`** — before the first release (E216) a short page without entries: an entry needs a release to stand under.
 *      From the first release on, every release's section (`## Upgrading to 0.2.0 from 0.1.0`, steps as `###` inside it) has its
 *      entries listed in {@link UPGRADING_ANCHORS}, and every listed entry stands under its release — each with an impact and its
 *      likelihood, and no placeholder left. The first section switches the requirement on: it is refused until its entries are listed.
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

/**
 * The entries UPGRADING.md must keep, by release — the version of its section (`## Upgrading to 0.2.0 from 0.1.0` → `'0.2.0'`) to
 * GitHub's anchors of its entries (`#### Medium: …`). A reworded heading changes its anchor: update it here.
 *
 * Empty until the first release (E216): there is nothing to upgrade from, and the page says so. The requirement switches on by
 * itself — the first `## Upgrading to …` section of UPGRADING.md is refused until its entries are listed here, and from then on every
 * listed entry must stand under its release.
 */
export const UPGRADING_ANCHORS: Readonly<Record<string, readonly string[]>> = {};

/** A release's section: `## Upgrading to <version> from <version>`. Steps (`### …`) inside it keep the release as the section. */
const RELEASE_SECTION = /^## Upgrading to (\d+\.\d+\.\d+\S*)\b/;

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

/** 6 · `UPGRADING.md`: nothing before the first release; from then on every listed entry under its release. */
export function checkUpgrading(repository: string, anchors: typeof UPGRADING_ANCHORS = UPGRADING_ANCHORS): string[] {
  const file = join(repository, 'UPGRADING.md');
  if (!existsSync(file)) return ['UPGRADING.md is missing (E168)'];
  const problems: string[] = [];
  const text = readFileSync(file, 'utf8');
  /** Entry anchor → the release it stands under (`undefined`: before any release section) and its text. */
  const entries = new Map<string, { release: string | undefined; body: string }>();
  const releases = new Set<string>();
  let release: string | undefined;
  let current: string | undefined;
  for (const line of text.split('\n')) {
    const heading = /^(#{1,4}) (.+)$/.exec(line);
    if (!heading) {
      if (current !== undefined) entries.get(current)!.body += `${line}\n`;
      continue;
    }
    if (heading[1]!.length <= 2) {
      release = RELEASE_SECTION.exec(line)?.[1];
      if (release !== undefined) releases.add(release);
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
  for (const version of releases) {
    if (!(version in anchors)) {
      problems.push(`UPGRADING.md has the section of ${version}, and scripts/check-changesets.ts lists none of its entries — add their anchors to UPGRADING_ANCHORS["${version}"]`);
    }
  }
  for (const [version, list] of Object.entries(anchors)) {
    if (!releases.has(version)) problems.push(`UPGRADING.md has no section "## Upgrading to ${version} from …", which scripts/check-changesets.ts lists`);
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
    const guide = Object.keys(UPGRADING_ANCHORS).length === 0 ? 'UPGRADING.md (no release yet)' : `${upgrading} UPGRADING entries`;
    console.log(
      `check-changesets: ${packages.length} packages at ${packages[0]?.manifest.version} in one fixed group, the changesets, release.yml, ` +
        `npm-trust.sh, ${guide} and the policies are in order${lint === undefined ? ' (actionlint not installed — skipped)' : ', actionlint clean'}.`,
    );
  }
}

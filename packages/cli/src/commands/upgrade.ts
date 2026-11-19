import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandInput } from '../command.ts';
import { readRegularFile } from '../files.ts';
import { readFrameworkState } from '../framework/app-framework.ts';
import { detectPackageManager, installArgs, manualCommands, PackageManagerProcess, snapshotInstallFiles, type GroupedInstallSpec, type PackageManagerName } from '../framework/package-manager.ts';
import { decideJump, parseTarget, resolveTarget } from '../framework/target.ts';
import { upgradeGuide, type GuideSection } from '../framework/upgrade-guide.ts';
import { compareVersions, parseVersion, releaseOf, type Version } from '../framework/versions.ts';
import { EXACT_VERSION } from '../framework/manifest.ts';
import { InstalledMarmeon } from '../spawn.ts';

/** The most of `UPGRADING.md` that is read. */
const MAX_GUIDE_BYTES = 4 * 1024 * 1024;

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

const IMPACT = { high: 'High', medium: 'Medium', low: 'Low' } as const;

/** One framework package of the app and where `upgrade` moves it. */
interface PlannedPackage {
  readonly name: string;
  readonly group: GroupedInstallSpec['group'];
  readonly from: string;
  readonly to: string;
}

/**
 * `marmeon upgrade`: moves every `marmeon` and `@marmeon/*` package of the app to one version (the `latest` tag, or `--to`), shows the entries of the
 * upgrade guide between the old and the new version, and regenerates the route and table types. Refuses a mixed, patched, overridden or
 * non-registry install, a downgrade and a workspace; `package.json` and the lockfile go back as they were when the install fails. It never lifts
 * `minimumReleaseAge`. See docs/releases.md#how-to-upgrade.
 */
export class UpgradeCommand {
  static command = 'upgrade';
  static description = 'Move every Marmeon package of the app to one version, show the upgrade guide and regenerate the types';
  static usage = '[--to=<version|tag>] [--dry-run] [--json]';
  static options = { to: { type: 'string' }, 'dry-run': { type: 'boolean' }, json: { type: 'boolean' } } as const;
  static boots = false;

  readonly #packageManager: PackageManagerProcess;
  readonly #marmeon: InstalledMarmeon;

  constructor(packageManager: PackageManagerProcess, marmeon: InstalledMarmeon) {
    this.#packageManager = packageManager;
    this.#marmeon = marmeon;
  }

  // Every import of this file is static, and nothing is imported by `import()` once the install has begun: the files of the running package
  // may be replaced or removed by then. What has to run the new version goes through `InstalledMarmeon`.
  async handle({ options, output, root, prompt }: CommandInput): Promise<number> {
    const json = options.json === true;
    const dryRun = options['dry-run'] === true;
    const request = parseTarget(typeof options.to === 'string' ? options.to : undefined);
    const fail = (message: string): number => {
      output.error(message);
      return 1;
    };

    const state = readFrameworkState(root);
    // Only an exact version the developer typed lifts the refusal of a mix: the install that follows is judged by the same check again.
    if (!state.ok && !(state.reason === 'mixed' && request.kind === 'version')) {
      const hint = state.reason === 'mixed' ? '\nPass --to=<exact version> to move every package to one version.' : state.fix === undefined ? '' : `\n${state.fix}`;
      return fail(`Cannot upgrade: ${state.message}${hint}`);
    }
    const listed = state.packages;
    const peerOnly = listed.filter((entry) => entry.group === 'peerDependencies');
    if (peerOnly.length > 0) {
      return fail(`Cannot upgrade: ${peerOnly.map((entry) => entry.name).join(', ')} ${peerOnly.length === 1 ? 'is' : 'are'} listed only in peerDependencies, which an install does not write to.\nList ${peerOnly.length === 1 ? 'it' : 'them'} in dependencies or devDependencies.`);
    }
    if (!listed.some((entry) => entry.name === 'marmeon')) {
      return fail('Cannot upgrade: package.json does not list marmeon, the package that runs the generators of the new version.\nList it with your package manager (pnpm add marmeon, npm install marmeon), then try again.');
    }
    const versions = listed.map((entry) => parseVersion(entry.installed ?? ''));
    if (versions.some((version) => version === undefined)) return fail('Cannot upgrade: an installed Marmeon package has a version that is not an exact version.\nReinstall it from the registry.');
    const installed = versions as Version[];
    const lowest = installed.reduce((low, version) => (compareVersions(version, low) < 0 ? version : low));
    const specsAt = (version: Version): GroupedInstallSpec[] => listed.map((entry) => ({ name: entry.name, group: entry.group as GroupedInstallSpec['group'], version }));

    const manager = detectPackageManager(root);
    if (!manager.ok) {
      let manual: string[] = [];
      try {
        if (request.kind === 'version') manual = manualCommands(manager.found, specsAt(request.version));
      } catch {
        // A package that cannot be named exactly gets no command.
      }
      const how = manual.length > 0 ? `Install every framework package at ${request.kind === 'version' ? request.version.text : ''} yourself:\n${manual.map((command) => `  ${command}`).join('\n')}` : 'Move every marmeon and @marmeon/* package to one version with your package manager.';
      return fail(`Cannot upgrade: ${manager.message}${manager.fix === undefined ? '' : `\n${manager.fix}`}\n${how}`);
    }

    const target = await resolveTarget(request, manager.name, this.#packageManager, root);
    if (!target.ok) return fail(target.message);
    const to = target.version;
    const jump = decideJump(installed, to);
    if (jump.kind === 'downgrade') return fail(`The target ${to.text} is below an installed version (${installed.map((version) => version.text).filter((text, index, all) => all.indexOf(text) === index).join(', ')}). marmeon upgrade does not downgrade; pass a higher --to.`);

    // The installed versions are not all a move can lower: a spec in package.json above the target would be lowered without a word.
    for (const entry of listed) {
      const pinned = EXACT_VERSION.test(entry.spec) ? parseVersion(entry.spec) : undefined;
      if (pinned && compareVersions(pinned, to) > 0) {
        return fail(`package.json pins ${entry.name} to ${entry.spec}, above ${to.text} (node_modules holds ${entry.installed}). marmeon upgrade does not downgrade: run ${manager.name} install, or pass a higher --to.`);
      }
    }

    const warnings: string[] = [];
    const say = (text = ''): void => {
      if (!json) output.line(text);
    };
    const warn = (text: string): void => {
      warnings.push(text);
      if (!json) output.warn(text);
    };
    // A range (`^1.1.0`) is not judged here: it names no one version, so an install that left another version in range is not seen. The restore message tells the developer to run `<pm> install`.
    // Never "already there" while something is out of line: a state the check refused (a second copy), or an exact spec in package.json that is not the installed version (an interrupted install).
    const outOfLine = !state.ok || listed.some((entry) => EXACT_VERSION.test(entry.spec) && entry.spec !== entry.installed);
    const move = jump.kind === 'move' || outOfLine;
    const breaking = jump.kind === 'move' && jump.breaking;
    const plan: PlannedPackage[] = listed.map((entry) => ({ name: entry.name, group: entry.group as PlannedPackage['group'], from: entry.installed!, to: to.text }));
    const lists = move ? installArgs(manager.name, specsAt(to)) : [];
    const commands = lists.map((args) => [manager.name, ...args]);
    const document = (extra: { guide: GuideSection[] | null; generated: { command: string; exitCode: number }[] | null }) => ({
      format: 1,
      dryRun,
      packageManager: manager.name,
      from: lowest.text,
      to: to.text,
      breaking,
      packages: plan,
      commands,
      guide: extra.guide === null ? null : extra.guide.map((section) => ({ version: section.version.text, from: section.from.text, anchor: section.anchor, entries: section.entries })),
      generated: extra.generated,
      warnings,
    });

    if (!move) {
      if (json) output.json(document({ guide: null, generated: null }));
      else output.success(`Every Marmeon package is already at ${to.text}.`);
      return 0;
    }

    printPlan(say, plan, commands, lowest, to, breaking);
    if (dryRun) {
      if (json) output.json(document({ guide: null, generated: null }));
      else say('Dry run: nothing was changed.');
      return 0;
    }

    // A person at the terminal confirms once. Without one, a breaking move needs the exact version on the command line.
    const asks = prompt.interactive && !json;
    if (breaking && !target.explicit && !asks) {
      return fail(`Moving from ${lowest.text} to ${to.text} may break the app. Read its upgrade guide section, then pass --to=${to.text} to go ahead.`);
    }
    if (asks) {
      const question = breaking
        ? `${lowest.text} to ${to.text} may break the app: UPGRADING.md has the section "Upgrading to ${releaseOf(to).text} from …" with what to change. Install it?`
        : `Install ${to.text}?`;
      const [answer] = await prompt.choose(question, ['Install', 'Cancel']);
      if (answer !== 0) return fail('Cancelled; nothing was changed.');
    }

    const controller = new AbortController();
    let stoppedBy: string | undefined;
    const handlers = SIGNALS.map((name) => {
      const handler = () => {
        stoppedBy ??= name;
        controller.abort();
      };
      process.on(name, handler);
      return [name, handler] as const;
    });
    // The handlers stay until the files are back, so a signal during the restore does not end the process half way.
    try {
      return await this.#run({ root, output, manager, lists, plan, lowest, to, breaking, json, asks, signal: controller.signal, stopped: () => stoppedBy, warn, say, finish: (guide, generated) => output.json(document({ guide, generated })), fail });
    } finally {
      for (const [name, handler] of handlers) process.off(name, handler);
    }
  }

  async #run(run: {
    readonly root: string;
    readonly output: CommandInput['output'];
    readonly manager: { readonly name: PackageManagerName; readonly lockfile: string };
    readonly lists: readonly (readonly string[])[];
    readonly plan: readonly PlannedPackage[];
    readonly lowest: Version;
    readonly to: Version;
    readonly breaking: boolean;
    readonly json: boolean;
    readonly asks: boolean;
    readonly signal: AbortSignal;
    readonly stopped: () => string | undefined;
    readonly warn: (text: string) => void;
    readonly say: (text?: string) => void;
    readonly finish: (guide: GuideSection[] | null, generated: { command: string; exitCode: number }[]) => void;
    readonly fail: (message: string) => number;
  }): Promise<number> {
    const { root, output, manager, lists, lowest, to, breaking, json, signal, warn, say, fail } = run;
    let snapshot: ReturnType<typeof snapshotInstallFiles> | undefined;
    let verified = false;
    const restoredFiles = ['package.json', manager.lockfile, ...(existsSync(join(root, 'pnpm-workspace.yaml')) ? ['pnpm-workspace.yaml'] : [])];
    // Every way out between the first package-manager call and the passed post-install check restores the files. After that check they are never restored: node_modules holds the target, and files at the old version would let the next run answer "already there".
    const undo = (reason: string): number => {
      let restored = '';
      try {
        snapshot?.restore();
      } catch (error) {
        restored = `\n${error instanceof Error ? error.message : 'The files could not be restored'}: restore ${restoredFiles.join(', ')} from version control.`;
      }
      const state = restored === '' ? `${restoredFiles.join(', ')} are back as they were.` : '';
      return fail(`${reason}. ${state}${restored} node_modules may hold some of the new packages: run "${manager.name} install" to bring it back in line.`);
    };
    try {
      // pnpm writes into pnpm-workspace.yaml too (a `minimumReleaseAgeExclude` entry), so a restore takes that file back as well.
      snapshot = snapshotInstallFiles(root, manager.lockfile, ['pnpm-workspace.yaml']);
      for (const args of lists) {
        if (signal.aborted) return undo(`it was stopped by ${run.stopped() ?? 'a signal'}`);
        const result = await this.#packageManager.run(manager.name, args, { cwd: root, interactive: run.asks, stdout: json ? 'stderr' : 'inherit', signal });
        if (result.code !== 0) {
          const ignored = manager.name === 'pnpm' ? '\nIf pnpm reported ERR_PNPM_IGNORED_BUILDS above, run pnpm approve-builds.' : '';
          return undo(`${manager.name} ${args[0]} failed with exit code ${result.code}${ignored}`);
        }
      }
      const after = readFrameworkState(root);
      // The check is the line: before it the files go back, after it they never do.
      if (!after.ok) return undo(`the install finished, but the app is not in one version: ${after.message}`);
      if (after.version.text !== to.text) {
        return undo(`the install finished, but the app is at ${after.version.text}, not ${to.text}; your package manager may have held ${to.text} back (docs/releases.md#the-first-day-after-a-release)`);
      }

      verified = true;
      const guide = readGuide(root, lowest, to, breaking, warn);
      if (guide !== null) printGuide(say, guide, lowest, to);

      const generated: { command: string; exitCode: number }[] = [];
      const stdout = json ? 'stderr' : 'inherit';
      const generators = ['route:types'];
      const problems: string[] = [];
      const again: string[] = [];
      // The packages the app itself lists decide (the check above read them from its package.json, within its root), never a node_modules above it, and nothing is imported after the install.
      if (after.packages.some((entry) => entry.name === '@marmeon/database')) generators.push('db:types');
      for (const [index, command] of generators.entries()) {
        if (signal.aborted) {
          problems.push(`it was stopped by ${run.stopped() ?? 'a signal'}`);
          again.push(...generators.slice(index));
          break;
        }
        try {
          const exitCode = await this.#marmeon.run(root, [command], { stdout, signal });
          if (exitCode === 0) generated.push({ command, exitCode });
          else {
            problems.push(`marmeon ${command} failed (exit code ${exitCode})`);
            again.push(command);
          }
        } catch (error) {
          const stopped = run.stopped();
          problems.push(stopped === undefined ? `marmeon ${command} could not run (${error instanceof Error ? error.message : String(error)})` : `marmeon ${command} was stopped by ${stopped}`);
          again.push(command);
        }
      }
      if (problems.length > 0) {
        return fail(`The packages are at ${to.text}, and package.json and ${manager.lockfile} keep it, but ${problems.join(' and ')}. Fix what it reports (the guide entries above may say what), then run ${again.map((command) => `marmeon ${command}`).join(' and ')}.`);
      }

      if (json) run.finish(guide, generated);
      else {
        output.success(`Every Marmeon package is at ${to.text}.`);
        say('Next:');
        if (generators.includes('db:types')) say('  marmeon migrate          apply the migrations of the new version');
        say('  marmeon doctor           check the app');
        say('  your tests');
      }
      return 0;
    } catch (error) {
      const stopped = run.stopped();
      if (verified) return fail(`The packages are at ${to.text}, and package.json and ${manager.lockfile} keep it, but ${stopped === undefined ? (error instanceof Error ? error.message : String(error)) : `it was stopped by ${stopped}`}. Run marmeon route:types, and marmeon db:types when the app has @marmeon/database.`);
      return undo(stopped === undefined ? (error instanceof Error ? error.message : String(error)) : `it was stopped by ${stopped}`);
    }
  }
}

function printPlan(say: (text?: string) => void, plan: readonly PlannedPackage[], commands: readonly (readonly string[])[], lowest: Version, to: Version, breaking: boolean): void {
  say(`Moving ${plan.length} Marmeon package${plan.length === 1 ? '' : 's'} from ${lowest.text} to ${to.text}${breaking ? ' (a breaking move)' : ''}:`);
  for (const entry of plan) say(`  ${entry.name}  ${entry.from} -> ${entry.to}`);
  say('The package manager runs:');
  for (const command of commands) say(`  ${command.join(' ')}`);
}

/**
 * The sections of the guide of the installed `marmeon` that the move from `from` to `to` has to read, or `null` with a warning when the guide
 * cannot be read. The file is read from the package's real directory, as a regular file, at most {@link MAX_GUIDE_BYTES}.
 */
function readGuide(root: string, from: Version, to: Version, breaking: boolean, warn: (text: string) => void): GuideSection[] | null {
  const unread = (why: string): null => {
    warn(`${why} Read the upgrade guide yourself: marmeon docs upgrading`);
    return null;
  };
  let directory: string;
  try {
    directory = realpathSync.native(join(root, 'node_modules', 'marmeon'));
  } catch {
    return unread('The upgrade guide comes with the marmeon package, which is not installed.');
  }
  const file = readRegularFile(join(directory, 'UPGRADING.md'), MAX_GUIDE_BYTES);
  if (file === undefined) return unread('The upgrade guide (UPGRADING.md of marmeon) could not be read.');
  if (file.truncated) return unread('The upgrade guide (UPGRADING.md of marmeon) is larger than Marmeon reads.');
  const sections = upgradeGuide(file.text, from, to);
  // A breaking move has a section; none means the page is not the guide of this release.
  if (breaking && sections.length === 0) return unread(`The upgrade guide has no section for ${from.text} to ${to.text}, though the move is breaking.`);
  return sections;
}

function printGuide(say: (text?: string) => void, sections: readonly GuideSection[], from: Version, to: Version): void {
  say();
  if (sections.length === 0) {
    say(`The upgrade guide has no entry between ${from.text} and ${to.text}.`);
    return;
  }
  for (const section of sections) {
    say(`Upgrading to ${section.version.text} from ${section.from.text}`);
    if (section.entries.length === 0) say('  (no entries)');
    for (const entry of section.entries) say(`  ${IMPACT[entry.impact]}: ${entry.title}`);
  }
  say('Read them: marmeon docs upgrading');
}

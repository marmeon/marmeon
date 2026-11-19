import { CommandArgumentsError, type CommandInput } from '../command.ts';
import { readFrameworkState, type FrameworkState, type ListedPackage } from '../framework/app-framework.ts';
import { detectPackageManager, installArgs, manualCommands, PackageManagerProcess, snapshotInstallFiles, type GroupedInstallSpec } from '../framework/package-manager.ts';
import { FRAMEWORK_PACKAGES } from '../framework/packages.ts';
import type { Output } from '../output.ts';

/** The short form of a name a person types: lower-case words joined by dashes. Anything else is no package name. */
const SHORT_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

const SCOPE = '@marmeon/';

/** The full name `argument` stands for, or `undefined`: only a name in the allow-list ever becomes one. */
function resolveName(argument: string): string | undefined {
  const full = argument.startsWith(SCOPE) ? argument : SHORT_NAME.test(argument) ? (argument === 'marmeon' ? argument : `${SCOPE}${argument}`) : undefined;
  return full !== undefined && FRAMEWORK_PACKAGES.has(full) ? full : undefined;
}

function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length]!;
}

/** Up to five names of the allow-list near `argument`, for a mistyped one. */
function closeNames(argument: string): string[] {
  const typed = argument.slice(0, 40).toLowerCase().replace(/^@marmeon\//, '');
  return [...FRAMEWORK_PACKAGES.keys()]
    .map((name) => ({ name, score: distance(typed, name.replace(SCOPE, '')) }))
    .filter(({ name, score }) => score <= 3 || (typed.length >= 3 && name.includes(typed)))
    .sort((a, b) => a.score - b.score)
    .slice(0, 5)
    .map(({ name }) => name);
}

/** Says why the install did not finish. The output of the package manager went to the terminal, so what it said cannot be read here: a pnpm that stops over an unapproved build script is named as a possible cause. */
function installFailure(output: Output, pm: string, reason: string): void {
  output.error(`${pm} did not finish: ${reason}.`);
  if (pm === 'pnpm') output.line('  If pnpm reported ERR_PNPM_IGNORED_BUILDS above, a dependency has a build script that is not approved: run `pnpm approve-builds`, then try again.');
}

/** Prints what a refusal of {@link readFrameworkState} says and how to go on. */
function printRefusal(output: Output, state: Extract<FrameworkState, { ok: false }>): void {
  output.error(state.message);
  if (state.fix !== undefined) output.line(`  ${state.fix}`);
  if (state.reason === 'mixed') output.line('  `marmeon check --only=packages` lists every package that is not in the version of the app.');
}

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/**
 * `marmeon add <package>...`: installs framework packages at exactly the version of the app, runs `discover` and copies the migrations
 * of a package that has some (`publish`). Only the names of the framework's own packages are accepted. See docs/packages.md#packages-you-add.
 */
export class AddCommand {
  static command = 'add';
  static description = 'Install framework packages at the version of the app, discover them and publish their migrations';
  static usage = '<package>... [--dry-run]';
  static options = { 'dry-run': { type: 'boolean' } } as const;
  static boots = false;

  readonly #manager: PackageManagerProcess;

  constructor(manager: PackageManagerProcess) {
    this.#manager = manager;
  }

  async handle({ args, options, output, root, spawn, prompt }: CommandInput): Promise<number> {
    if (args.length === 0) throw new CommandArgumentsError(`Name the packages to add, e.g. \`marmeon add redis\`.\nUsage: marmeon add ${AddCommand.usage}`);
    const requested = new Set<string>();
    for (const argument of args) {
      const name = resolveName(argument);
      if (name === undefined) {
        const near = closeNames(argument);
        throw new CommandArgumentsError(
          `"${argument.slice(0, 60)}" is not a package of the framework. Name it without a version, short (redis) or in full (@marmeon/redis): marmeon installs the version of your app.` +
            (near.length > 0 ? `\nDid you mean: ${near.join(', ')}?` : ''),
        );
      }
      requested.add(name);
    }

    const state = readFrameworkState(root);
    if (!state.ok) {
      printRefusal(output, state);
      return 1;
    }
    // A package only in "peerDependencies" is the app's promise to provide it, not an install (a package listed there and elsewhere is judged by the other listing).
    const peer = state.packages.find((listed) => listed.group === 'peerDependencies' && requested.has(listed.name));
    if (peer !== undefined) {
      output.error(`${peer.name} is listed only in "peerDependencies" of package.json, and marmeon add does not guess where it belongs.`);
      output.line(`  Move it to "dependencies" or "devDependencies" with the version ${state.version.text}, or install it with your package manager.`);
      return 1;
    }
    const listedAs = (name: string): ListedPackage | undefined => state.packages.find((listed) => listed.name === name);

    const todo = [...requested].filter((name) => {
      const listed = listedAs(name);
      if (listed === undefined) return true;
      output.line(`${name} is already installed (${listed.installed}).`);
      return false;
    });
    if (todo.length === 0) return 0;

    const specs: GroupedInstallSpec[] = todo.map((name) => ({ name, version: state.version, group: FRAMEWORK_PACKAGES.get(name)!.dev ? 'devDependencies' : 'dependencies' }));
    const pm = detectPackageManager(root);
    if (!pm.ok) {
      output.error(pm.message);
      if (pm.fix !== undefined) output.line(`  ${pm.fix}`);
      const manual = manualCommands(pm.found, specs);
      if (manual.length > 0) {
        output.line('  Install the packages yourself, then run `marmeon discover`:');
        for (const command of manual) output.line(`    ${command}`);
      } else {
        output.line(`  Install ${todo.join(', ')} at the version ${state.version.text} with your package manager, then run \`marmeon discover\`.`);
      }
      return 1;
    }

    const lists = installArgs(pm.name, specs);
    const publishes = todo.filter((name) => FRAMEWORK_PACKAGES.get(name)!.migrations);
    if (options['dry-run'] === true) {
      for (const list of lists) output.line(`${pm.name} ${list.join(' ')}`);
      output.line('marmeon discover');
      for (const name of publishes) output.line(`marmeon publish ${name}`);
      return 0;
    }

    let snapshot;
    try {
      snapshot = snapshotInstallFiles(root, pm.lockfile);
    } catch {
      output.error(`package.json or ${pm.lockfile} could not be read, so a failed install could not be taken back. Nothing was installed.`);
      return 1;
    }

    // Ctrl-C and SIGTERM stop the package manager and then the command, which restores the files once the run has settled: these handlers
    // replace Node's default exit, so the command ends itself. They stay until the files are back, or a second signal would end the process half-way.
    const controller = new AbortController();
    const abort = () => controller.abort();
    for (const signal of SIGNALS) process.on(signal, abort);
    try {
      let failed: string | undefined;
      try {
        for (const list of lists) {
          if (controller.signal.aborted) break;
          const result = await this.#manager.run(pm.name, list, { cwd: root, interactive: prompt.interactive, stdout: 'inherit', signal: controller.signal });
          if (result.code !== 0) {
            failed = `it exited with code ${result.code}`;
            break;
          }
        }
        if (failed === undefined && controller.signal.aborted) failed = 'it was interrupted';
      } catch (error) {
        failed = error instanceof Error ? error.message : 'it failed';
      }
      if (failed !== undefined) {
        installFailure(output, pm.name, failed);
        try {
          snapshot.restore();
          output.line(`  package.json and ${pm.lockfile} are as they were. ${pm.name} may have changed node_modules: \`${pm.name} install\` brings it back.`);
        } catch (error) {
          output.error(`${error instanceof Error ? error.message : 'The files could not be restored'}: put package.json and ${pm.lockfile} back from your version control, then run \`${pm.name} install\`.`);
        }
        return 1;
      }
    } finally {
      for (const signal of SIGNALS) process.off(signal, abort);
    }

    const after = readFrameworkState(root);
    const wrong = after.ok ? todo.filter((name) => {
      const listed = after.packages.find((entry) => entry.name === name);
      // The installed version is defence in depth: `readFrameworkState` reports a package in another version as `mixed` first.
      return listed?.spec !== state.version.text || listed.installed !== state.version.text;
    }) : [];
    if (!after.ok || wrong.length > 0) {
      output.error(after.ok ? `${wrong.join(', ')} ${wrong.length === 1 ? 'is' : 'are'} not installed at the version ${state.version.text} of your app.` : `The packages are installed, but ${after.message}.`);
      if (!after.ok && after.fix !== undefined) output.line(`  ${after.fix}`);
      output.line('  A release younger than your package manager allows is not installed: see docs/releases.md#the-first-day-after-a-release. `marmeon check --only=packages` lists what differs.');
      return 1;
    }

    if ((await spawn('discover')) !== 0) {
      output.error(`${todo.join(', ')} installed, but discovery failed. Run \`marmeon discover\` and read what it says.`);
      // Running `add` again stops early, the packages being installed: what is left has to be named here.
      if (publishes.length > 0) {
        output.line('  Once it succeeds, publish the migrations and run them:');
        for (const name of publishes) output.line(`    marmeon publish ${name}`);
        output.line('    marmeon migrate');
      }
      return 1;
    }
    for (const [index, name] of publishes.entries()) {
      if ((await spawn('publish', name)) !== 0) {
        output.error(`${name} is installed, but publishing its migrations failed. Once the app boots (it needs a valid .env), run:`);
        for (const rest of publishes.slice(index)) output.line(`  marmeon publish ${rest}`);
        return 1;
      }
    }

    for (const name of todo) output.success(`Added ${name}@${state.version.text}`);
    if (publishes.length > 0) output.line('Next: marmeon migrate');
    for (const name of todo) output.line(`Read more: marmeon docs ${FRAMEWORK_PACKAGES.get(name)!.docs}`);
    return 0;
  }
}

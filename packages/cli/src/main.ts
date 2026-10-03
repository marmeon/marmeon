import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Application, ConfigError, Container, createApplication, type ApplicationOptions } from '@bespokecore/core';
import { CommandArgumentsError, CommandRegistry, parseCommandArgs, runCommand, type CommandClass } from './command.ts';
import { BuildCommand } from './commands/build.ts';
import { DiscoverCommand } from './commands/discover.ts';
import { KeyGenerateCommand } from './commands/key-generate.ts';
import { printCommandList } from './commands/list.ts';
import {
  MakeControllerCommand,
  MakeEventCommand,
  MakeJobCommand,
  MakeListenerCommand,
  MakeMiddlewareCommand,
  MakeMigrationCommand,
  MakeModuleCommand,
} from './commands/make.ts';
import { PackageBuildCommand } from './commands/package-build.ts';
import { RouteListCommand } from './commands/route-list.ts';
import { RouteTypesCommand } from './commands/route-types.ts';
import { ServeCommand } from './commands/serve.ts';
import { Output } from './output.ts';
import { spawnBespoke } from './spawn.ts';

export { spawnBespoke, startBespoke } from './spawn.ts';

const BUILT_IN: readonly CommandClass[] = [
  ServeCommand,
  RouteListCommand,
  RouteTypesCommand,
  DiscoverCommand,
  BuildCommand,
  PackageBuildCommand,
  KeyGenerateCommand,
  MakeModuleCommand,
  MakeControllerCommand,
  MakeEventCommand,
  MakeListenerCommand,
  MakeJobCommand,
  MakeMiddlewareCommand,
  MakeMigrationCommand,
];

/** Runs one `bespoke` invocation in the app root (`cwd`) and returns the exit code. */
export async function run(argv: readonly string[], root = process.cwd()): Promise<number> {
  const output = new Output();
  const [name = 'list', ...rest] = argv;
  const builtIn = BUILT_IN.find((command) => command.command === name);
  const listing = name === 'list' || name === 'help' || name === '--help' || name === '-h';

  // Boot the application unless the command works without it (generators, tooling).
  let app: Application | undefined;
  if (listing || !builtIn || builtIn.boots !== false) {
    const loaded = await loadApplication(root);
    if (loaded instanceof Error) {
      if (!listing) {
        output.error(loaded instanceof ConfigError ? loaded.message : `Could not start the application: ${loaded.message}`);
        return 1;
      }
      output.warn(`${loaded.message.split('\n')[0]} — showing built-in commands only.`);
    } else {
      app = loaded;
    }
  }

  const registry = app?.container.has(CommandRegistry) ? app.container.make(CommandRegistry) : new CommandRegistry();
  registry.add(BUILT_IN);

  if (listing) {
    printCommandList({ output }, registry.all());
    return 0;
  }

  const Command = registry.get(name);
  if (!Command) {
    output.error(`Command "${name}" is not defined. Run "bespoke list" to see all commands.`);
    return 1;
  }

  try {
    parseCommandArgs(Command, rest);
  } catch (error) {
    if (!(error instanceof CommandArgumentsError)) throw error;
    output.error(error.message);
    return 1;
  }

  // Commands are built through the container, so they get constructor injection — in a scope of their own, like a
  // request or a job: scoped services (a Translator, in APP_LOCALE) resolve, and start fresh for each command.
  // The app shuts down afterwards (pools, handles), or an open connection would keep the process alive.
  try {
    return await runCommand(app?.container.createScope() ?? new Container(), Command, rest, { output, root, spawn: (...args) => spawnBespoke(root, args) });
  } catch (error) {
    printError(output, error);
    return 1;
  } finally {
    await app?.shutdown();
  }
}

/** A failed command: its error and where it came from — not Node's dump of every property of every cause. */
function printError(output: Output, error: unknown): void {
  if (!(error instanceof Error)) {
    output.error(String(error));
    return;
  }
  const frames = (error.stack ?? '').split('\n').filter((line) => /^\s+at /.test(line) && !line.includes('node:internal'));
  output.error([`${error.name}: ${error.message}`, ...frames.slice(0, 5).map((frame) => `  ${frame.trim()}`)].join('\n'));
}

/** Imports `bootstrap/app.ts` — whose default export describes the app — and boots it. */
async function loadApplication(root: string): Promise<Application | Error> {
  const entry = join(root, 'bootstrap', 'app.ts');
  if (!existsSync(entry)) return new Error(`No BespokeCore app in ${root} (bootstrap/app.ts not found)`);
  try {
    const module = (await import(pathToFileURL(entry).href)) as { default?: ApplicationOptions };
    if (!module.default || typeof module.default.root !== 'string') {
      return new Error('bootstrap/app.ts must `export default defineApplication({ … })`.');
    }
    return await createApplication(module.default);
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

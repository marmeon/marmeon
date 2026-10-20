import type { CommandClass } from './command.ts';
import { AgentsSyncCommand } from './commands/agents-sync.ts';
import { BuildCommand } from './commands/build.ts';
import { CheckCommand } from './commands/check.ts';
import { DiscoverCommand } from './commands/discover.ts';
import { DocsCommand } from './commands/docs.ts';
import { KeyGenerateCommand } from './commands/key-generate.ts';
import { MakeDockerCommand } from './commands/make-docker.ts';
import { MakeLintConfigCommand } from './commands/make-lint-config.ts';
import {
  MakeCommandCommand,
  MakeControllerCommand,
  MakeEventCommand,
  MakeJobCommand,
  MakeListenerCommand,
  MakeMiddlewareCommand,
  MakeMigrationCommand,
  MakeModuleCommand,
  MakeNotificationCommand,
  MakeSeederCommand,
} from './commands/make.ts';
import { ModulesCheckCommand } from './commands/modules-check.ts';
import { PackageBuildCommand } from './commands/package-build.ts';
import { RouteListCommand } from './commands/route-list.ts';
import { RouteTypesCommand } from './commands/route-types.ts';
import { SchemaProjectCommand } from './commands/schema-project.ts';
import { ServeCommand } from './commands/serve.ts';
import { TinkerCommand } from './commands/tinker.ts';

/** The commands the CLI provides. */
export const BUILT_IN: readonly CommandClass[] = [
  ServeCommand,
  RouteListCommand,
  RouteTypesCommand,
  ModulesCheckCommand,
  SchemaProjectCommand,
  DiscoverCommand,
  BuildCommand,
  CheckCommand,
  PackageBuildCommand,
  KeyGenerateCommand,
  AgentsSyncCommand,
  DocsCommand,
  TinkerCommand,
  MakeModuleCommand,
  MakeControllerCommand,
  MakeEventCommand,
  MakeListenerCommand,
  MakeJobCommand,
  MakeNotificationCommand,
  MakeCommandCommand,
  MakeSeederCommand,
  MakeMiddlewareCommand,
  MakeMigrationCommand,
  MakeLintConfigCommand,
  MakeDockerCommand,
];

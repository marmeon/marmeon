/**
 * What the framework's own packages import from the CLI: the command registry and the way a command runs outside `marmeon`
 * (the scheduler's `s.command()`). Not API, can change in any release — an app imports from `marmeon`.
 * @internal
 */
export { CommandRegistry, runCommand } from './command.ts';
export { spawnMarmeon } from './spawn.ts';

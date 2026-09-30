import type { CommandClass, CommandInput } from '../command.ts';
import { style } from '../output.ts';

/** `bespoke` without arguments: every command, grouped by namespace (like `artisan list`). */
export function printCommandList({ output }: Pick<CommandInput, 'output'>, commands: readonly CommandClass[]): void {
  output.line(`${style('bold', 'BespokeCore')}  ${style('dim', 'usage: bespoke <command> [arguments] [--options]')}`);
  const visible = [...LAUNCHER, ...commands.filter((command) => !command.hidden)];
  const width = Math.max(...visible.map((command) => command.command.length));
  let group: string | undefined;
  for (const command of visible.sort((a, b) => namespace(a).localeCompare(namespace(b)) || a.command.localeCompare(b.command))) {
    if (namespace(command) !== group) {
      group = namespace(command);
      output.line();
      output.line(style('yellow', group || 'Available commands'));
    }
    output.line(`  ${style('green', command.command.padEnd(width))}  ${command.description}`);
  }
}

function namespace(command: Pick<CommandClass, 'command'>): string {
  return command.command.includes(':') ? command.command.split(':')[0]! : '';
}

/** Handled by the launcher (bin/bespoke.js), listed for completeness. */
const LAUNCHER = [
  { command: 'dev', description: 'Start the development server (restarts on changes, HMR for views)' },
  { command: 'start', description: 'Start the production server (after bespoke build)' },
] as unknown as CommandClass[];
